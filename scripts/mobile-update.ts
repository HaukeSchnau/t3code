#!/usr/bin/env node
// Resolves the mobile runtime version and publishes the JavaScript bundle as a
// self-hosted Expo update (protocol v1, https://docs.expo.dev/technical-specs/expo-updates-1/).
//
// Layout under --updates-dir, which the fork's update host serves statically:
//   assets/<sha256>.<ext>                        immutable, content-addressed files
//   <platform>/<runtime-version>/manifest.json   the newest update for that runtime
// The host answers GET /manifest by routing the Expo-Platform and
// Expo-Runtime-Version request headers to the matching manifest, and 204 otherwise.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { BadArgument, PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
// Expo Updates keys assets by MD5, which WebCrypto lacks.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

export class MobileUpdateError extends Schema.TaggedError<MobileUpdateError>()(
  "MobileUpdateError",
  { message: Schema.String },
) {}

export interface UpdateAsset {
  readonly hash: string;
  readonly key: string;
  readonly contentType: string;
  readonly fileExtension: string;
  readonly url: string;
}

const ExportMetadata = Schema.Struct({
  fileMetadata: Schema.Record(
    Schema.String,
    Schema.Struct({
      bundle: Schema.String,
      assets: Schema.Array(Schema.Struct({ path: Schema.String, ext: Schema.String })),
    }),
  ),
});
const decodeExportMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(ExportMetadata));

/** The parts of a published manifest that pruning needs. */
const PublishedManifest = Schema.Struct({
  launchAsset: Schema.Struct({ url: Schema.String }),
  assets: Schema.Array(Schema.Struct({ url: Schema.String })),
});
const decodePublishedManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PublishedManifest),
);
const decodeResolvedRuntime = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ runtimeVersion: Schema.String })),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const CONTENT_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  wav: "audio/wav",
  webp: "image/webp",
};

/**
 * Describes one exported file as Expo Updates addresses it: `key` is the MD5
 * that Metro's asset registry uses, `hash` the base64url SHA-256 the client
 * verifies, and the stored name content-addresses the file on the host.
 */
export function describeAsset(
  bytes: Uint8Array,
  extension: string,
  isLaunchAsset: boolean,
  manifestUrl: URL,
): { readonly storedName: string; readonly asset: UpdateAsset } {
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest();
  const storedName = `${sha256.toString("hex")}.${extension}`;
  return {
    storedName,
    asset: {
      hash: sha256.toString("base64url"),
      key: NodeCrypto.createHash("md5").update(bytes).digest("hex"),
      contentType: isLaunchAsset
        ? "application/javascript"
        : (CONTENT_TYPES[extension] ?? "application/octet-stream"),
      fileExtension: isLaunchAsset ? ".bundle" : `.${extension}`,
      url: new URL(`assets/${storedName}`, manifestUrl).href,
    },
  };
}

/** Identical content yields the same ID, so republishing it is a no-op for clients. */
export function updateId(
  runtimeVersion: string,
  assets: ReadonlyArray<UpdateAsset>,
  expoClient: unknown,
) {
  const hex = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([runtimeVersion, assets.map((asset) => asset.hash), expoClient]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Binaries this old have been replaced through TestFlight. */
export const RUNTIME_RETENTION_MS = 30 * DAY_MS;
/** Covers clients that fetched a manifest shortly before a newer publish replaced it. */
export const ASSET_GRACE_MS = 2 * DAY_MS;

/** Chooses stale runtime manifests, and assets that no remaining manifest references. */
export function selectPrunable(input: {
  readonly manifests: ReadonlyArray<{
    readonly path: string;
    readonly modifiedAtMs: number;
    readonly assetNames: ReadonlyArray<string>;
  }>;
  readonly assets: ReadonlyArray<{ readonly name: string; readonly modifiedAtMs: number }>;
  readonly nowMs: number;
}) {
  const staleManifests = input.manifests.filter(
    (manifest) => input.nowMs - manifest.modifiedAtMs > RUNTIME_RETENTION_MS,
  );
  const referenced = new Set(
    input.manifests
      .filter((manifest) => !staleManifests.includes(manifest))
      .flatMap((manifest) => manifest.assetNames),
  );
  return {
    manifests: staleManifests.map((manifest) => manifest.path),
    assets: input.assets
      .filter(
        (asset) => !referenced.has(asset.name) && input.nowMs - asset.modifiedAtMs > ASSET_GRACE_MS,
      )
      .map((asset) => asset.name),
  };
}

const mobileRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* path.fromFileUrl(new URL("../", import.meta.url)), "apps/mobile");
});

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (a, b) => a + b,
    ),
  );

/** Runs an Expo CLI from the mobile app with the production distribution environment. */
const expo = Effect.fn("mobileUpdate.expo")(function* (
  binary: "expo" | "expo-updates",
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const cwd = yield* mobileRoot;
  const child = yield* spawner.spawn(
    ChildProcess.make(path.join(cwd, "node_modules/.bin", binary), args, {
      cwd,
      env: { APP_VARIANT: "production", CI: "1", EXPO_NO_GIT_STATUS: "1", ...env },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    }),
  );
  const [stdout, code] = yield* Effect.all([collect(child.stdout), child.exitCode], {
    concurrency: "unbounded",
  });
  if (code !== 0)
    return yield* new MobileUpdateError({ message: `${binary} ${args[0]} failed (${code}).` });
  return stdout;
}, Effect.scoped);

/**
 * TODO: Remove once hermes-compiler ships a linux-arm64 hermesc. Until then the
 * fork's aarch64 CI hosts run its static x86-64 binary under qemu-user.
 */
const hermesOverride = Effect.fn("mobileUpdate.hermesOverride")(function* (
  scratch: string,
): Effect.fn.Return<
  Record<string, string>,
  BadArgument | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  if ((yield* HostProcessPlatform) !== "linux" || (yield* HostProcessArchitecture) !== "arm64")
    return {};
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reactNative = NodeModule.createRequire(
    path.join(yield* mobileRoot, "package.json"),
  ).resolve("react-native/package.json");
  const compiler = NodeModule.createRequire(reactNative).resolve("hermes-compiler/package.json");
  const hermesc = path.join(path.dirname(compiler), "hermesc/linux64-bin/hermesc");
  const directory = path.join(scratch, "hermes");
  const wrapper = path.join(directory, "build/bin/hermesc");
  yield* fs.makeDirectory(path.dirname(wrapper), { recursive: true });
  yield* fs.writeFileString(wrapper, `#!/bin/sh\nexec qemu-x86_64 '${hermesc}' "$@"\n`);
  yield* fs.chmod(wrapper, 0o755);
  return { REACT_NATIVE_OVERRIDE_HERMES_DIR: directory };
});

/** Writes through a sibling temp file so the host never serves a partial file. */
const writeAtomically = Effect.fn("mobileUpdate.writeAtomically")(function* (
  target: string,
  data: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  yield* fs.writeFile(temporary, data);
  yield* fs.rename(temporary, target);
});

const prune = Effect.fn("mobileUpdate.prune")(function* (updatesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modifiedAtMs = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) =>
        info.mtime.pipe(
          Option.map((mtime) => mtime.getTime()),
          Option.getOrElse(() => 0),
        ),
      ),
    );
  const assetsDir = path.join(updatesDir, "assets");
  const manifestPaths = (yield* fs.readDirectory(updatesDir, { recursive: true })).filter(
    (entry) => path.basename(entry) === "manifest.json",
  );
  const manifests = yield* Effect.forEach(manifestPaths, (relative) =>
    Effect.gen(function* () {
      const file = path.join(updatesDir, relative);
      const manifest = yield* decodePublishedManifest(yield* fs.readFileString(file));
      return {
        path: file,
        modifiedAtMs: yield* modifiedAtMs(file),
        assetNames: [manifest.launchAsset, ...manifest.assets].map((asset) =>
          path.basename(new URL(asset.url).pathname),
        ),
      };
    }),
  );
  const assets = yield* Effect.forEach(yield* fs.readDirectory(assetsDir), (name) =>
    Effect.map(modifiedAtMs(path.join(assetsDir, name)), (ms) => ({ name, modifiedAtMs: ms })),
  );
  const prunable = selectPrunable({ manifests, assets, nowMs: yield* Clock.currentTimeMillis });
  yield* Effect.forEach(prunable.manifests, (file) =>
    fs.remove(path.dirname(file), { recursive: true }),
  );
  yield* Effect.forEach(prunable.assets, (name) => fs.remove(path.join(assetsDir, name)));
  return { manifests: prunable.manifests.length, assets: prunable.assets.length };
});

const platformFlag = Flag.Literals("platform", ["ios", "android"]).pipe(Flag.withDefault("ios"));
const updatesUrlFlag = Flag.String("updates-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Manifest URL that builds poll, e.g. https://updates.example/manifest."),
);

const runtimeVersionCommand = Command.make(
  "runtime-version",
  { platform: platformFlag, updatesUrl: updatesUrlFlag },
  Effect.fn("mobileUpdate.runtimeVersion")(function* ({ platform, updatesUrl }) {
    const output = yield* expo("expo-updates", ["runtimeversion:resolve", "--platform", platform], {
      T3CODE_MOBILE_UPDATES_URL: updatesUrl.href,
    });
    yield* Console.log((yield* decodeResolvedRuntime(output)).runtimeVersion);
  }),
).pipe(
  Command.withDescription(
    "Print the fingerprint runtime version. Distribution builds pin this value so every host agrees.",
  ),
);

const publishCommand = Command.make(
  "publish",
  {
    platform: platformFlag,
    updatesUrl: updatesUrlFlag,
    runtimeVersion: Flag.String("runtime-version").pipe(
      Flag.withSchema(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))),
    ),
    updatesDir: Flag.Directory("updates-dir", { mustExist: true }),
  },
  Effect.fn("mobileUpdate.publish")(function* ({
    platform,
    updatesUrl,
    runtimeVersion,
    updatesDir,
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mobile-update-" });
    const exportDir = path.join(scratch, "export");
    const env = {
      T3CODE_MOBILE_UPDATES_URL: updatesUrl.href,
      T3CODE_MOBILE_RUNTIME_VERSION: runtimeVersion,
    };

    yield* expo("expo", ["export", "--platform", platform, "--output-dir", exportDir], {
      ...env,
      ...(yield* hermesOverride(scratch)),
    });
    const expoClient = yield* decodeJson(
      yield* expo("expo", ["config", "--type", "public", "--json"], env),
    );
    const exported = (yield* decodeExportMetadata(
      yield* fs.readFileString(path.join(exportDir, "metadata.json")),
    )).fileMetadata[platform];
    if (!exported)
      return yield* new MobileUpdateError({ message: `The export has no ${platform} bundle.` });

    const files = [
      {
        source: exported.bundle,
        extension: path.extname(exported.bundle).slice(1) || "js",
        isLaunchAsset: true,
      },
      ...exported.assets.map((asset) => ({
        source: asset.path,
        extension: asset.ext,
        isLaunchAsset: false,
      })),
    ];
    const [launchAsset, ...assets] = yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        const bytes = yield* fs.readFile(path.join(exportDir, file.source));
        const described = describeAsset(bytes, file.extension, file.isLaunchAsset, updatesUrl);
        const stored = path.join(updatesDir, "assets", described.storedName);
        if (!(yield* fs.exists(stored))) yield* writeAtomically(stored, bytes);
        return described.asset;
      }),
    );
    if (!launchAsset) return yield* new MobileUpdateError({ message: "The export has no bundle." });

    const manifest = {
      id: updateId(runtimeVersion, [launchAsset, ...assets], expoClient),
      createdAt: DateTime.formatIso(yield* DateTime.now),
      runtimeVersion,
      launchAsset,
      assets,
      metadata: {},
      extra: { expoClient },
    };
    yield* writeAtomically(
      path.join(updatesDir, platform, runtimeVersion, "manifest.json"),
      new TextEncoder().encode(yield* encodeJson(manifest)),
    );
    const pruned = yield* prune(updatesDir);
    yield* Console.log(
      `Published ${platform} update ${manifest.id} for runtime ${runtimeVersion} (${assets.length} assets; pruned ${pruned.manifests} runtimes, ${pruned.assets} assets).`,
    );
  }, Effect.scoped),
).pipe(Command.withDescription("Export the bundle and publish it as the runtime's newest update."));

const mobileUpdateCommand = Command.make("mobile-update").pipe(
  Command.withSubcommands([runtimeVersionCommand, publishCommand]),
);

if (import.meta.main) {
  Command.run(mobileUpdateCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
