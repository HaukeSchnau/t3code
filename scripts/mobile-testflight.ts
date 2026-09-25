#!/usr/bin/env node
// Builds the production iOS app and uploads it to TestFlight unless a current
// build already exists for the pinned runtime version. Runs on the Apple builder.
//
// JavaScript-only changes ship as OTA updates (scripts/mobile-update.ts), so a
// new binary is needed only when the native fingerprint changes or the last
// binary nears TestFlight's 90-day expiry. Each upload's "What to Test" note
// records its runtime version; that note is how later runs find the build.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
// App Store Connect tokens are ES256 JWTs; WebCrypto would need a PKCS#8 import dance for the same result.
import * as NodeCrypto from "node:crypto";

export class TestFlightError extends Schema.TaggedError<TestFlightError>()("TestFlightError", {
  message: Schema.String,
}) {}

const DAY_MS = 24 * 60 * 60 * 1000;
/** TestFlight expires builds after 90 days; replace them with margin to spare. */
export const BUILD_REFRESH_MS = 60 * DAY_MS;
const UNUSABLE_PROCESSING_STATES = new Set(["FAILED", "INVALID"]);

export const runtimeNote = (runtimeVersion: string) => `Runtime: ${runtimeVersion}`;

/**
 * CFBundleVersion from the UTC upload minute, e.g. 260924.2130. It increases
 * across CI runs and manual uploads alike without shared state.
 */
export function buildNumberAt(nowMs: number) {
  const [date = "", time = ""] = DateTime.formatIso(DateTime.makeUnsafe(nowMs))
    .slice(2, 16)
    .split("T");
  return `${date.replaceAll("-", "")}.${Number(time.replace(":", ""))}`;
}

const Build = Schema.Struct({
  id: Schema.String,
  attributes: Schema.Struct({
    version: Schema.String,
    uploadedDate: Schema.String,
    expired: Schema.Boolean,
    processingState: Schema.String,
  }),
  relationships: Schema.Struct({
    betaBuildLocalizations: Schema.Struct({
      data: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  }),
});
const Localization = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  attributes: Schema.Struct({ locale: Schema.String, whatsNew: Schema.NullOr(Schema.String) }),
});
const BuildsResponse = Schema.Struct({
  data: Schema.Array(Build),
  included: Schema.optional(Schema.Array(Localization)),
});
const AppsResponse = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const ExpoConfig = Schema.Struct({
  ios: Schema.Struct({ bundleIdentifier: Schema.String, appleTeamId: Schema.String }),
});
const decodeBuilds = Schema.decodeUnknownEffect(BuildsResponse);
const decodeApps = Schema.decodeUnknownEffect(AppsResponse);
const decodeExpoConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ExpoConfig));

type BuildsPage = typeof BuildsResponse.Type;

/** Finds a usable build whose note names this runtime and that is not near expiry. */
export function findCurrentBuild(page: BuildsPage, runtimeVersion: string, nowMs: number) {
  const notes = new Map(
    (page.included ?? []).map((entry) => [entry.id, entry.attributes.whatsNew ?? ""]),
  );
  return page.data.find(
    (build) =>
      !build.attributes.expired &&
      !UNUSABLE_PROCESSING_STATES.has(build.attributes.processingState) &&
      nowMs - Date.parse(build.attributes.uploadedDate) < BUILD_REFRESH_MS &&
      build.relationships.betaBuildLocalizations.data.some((localization) =>
        (notes.get(localization.id) ?? "").split("\n").includes(runtimeNote(runtimeVersion)),
      ),
  );
}

const ApiKey = Config.all({
  path: Config.String("APP_STORE_CONNECT_API_KEY_PATH"),
  id: Config.String("APP_STORE_CONNECT_API_KEY_ID"),
  issuer: Config.String("APP_STORE_CONNECT_API_ISSUER_ID"),
});
type ApiKey = Config.Success<typeof ApiKey>;

/** App Store Connect API client authenticated with a short-lived team key JWT. */
const makeAppStoreConnect = Effect.fn("makeAppStoreConnect")(function* (key: ApiKey) {
  const fs = yield* FileSystem.FileSystem;
  const privateKey = NodeCrypto.createPrivateKey(yield* fs.readFileString(key.path));
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://api.appstoreconnect.apple.com")),
    HttpClient.retryTransient({ times: 3 }),
  );
  const token = Effect.map(Clock.currentTimeMillis, (nowMs) => {
    const issuedAt = Math.floor(nowMs / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "ES256", kid: key.id, typ: "JWT" })}.${encode({
      iss: key.issuer,
      iat: issuedAt,
      exp: issuedAt + 15 * 60,
      aud: "appstoreconnect-v1",
    })}`;
    const signature = NodeCrypto.sign("sha256", Buffer.from(unsigned), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${unsigned}.${signature.toString("base64url")}`;
  });
  return Effect.fn("appStoreConnect.request")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* client.execute(
      request.pipe(HttpClientRequest.bearerToken(yield* token)),
    );
    yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.tapError(() =>
        response.text.pipe(
          Effect.flatMap((body) => Console.error(`App Store Connect: ${body}`)),
          Effect.ignore,
        ),
      ),
    );
    return yield* response.json;
  });
});

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (a, b) => a + b,
    ),
  );

/** Runs a build tool with inherited output, or captures stdout when `capture` is set. */
const run = Effect.fn("mobileTestFlight.run")(function* (
  program: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string>;
    readonly capture?: boolean;
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(program, args, {
      cwd: options.cwd,
      // CocoaPods fails on non-UTF-8 locales, which launchd-started runners default to.
      env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", ...options.env },
      extendEnv: true,
      stdin: "ignore",
      stdout: options.capture ? "pipe" : "inherit",
      stderr: "inherit",
    }),
  );
  const [stdout, code] = yield* Effect.all([collect(child.stdout), child.exitCode], {
    concurrency: "unbounded",
  });
  if (code !== 0)
    return yield* new TestFlightError({ message: `${program} ${args[0]} failed (${code}).` });
  return stdout;
}, Effect.scoped);

const exportOptions = (teamId: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${teamId}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`;

const releaseCommand = Command.make(
  "mobile-testflight",
  {
    runtimeVersion: Flag.String("runtime-version").pipe(
      Flag.withSchema(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))),
      Flag.withDescription("Runtime version resolved by `mobile-update.ts runtime-version`."),
    ),
    updatesUrl: Flag.String("updates-url").pipe(Flag.withSchema(Schema.URLFromString)),
    notes: Flag.String("notes").pipe(
      Flag.withDescription("Shown to testers above the runtime line, e.g. the commit subject."),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Upload even if a current build exists for this runtime."),
    ),
  },
  Effect.fn("mobileTestFlight.release")(function* ({ runtimeVersion, updatesUrl, notes, force }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const key = yield* ApiKey;
    const buildNumber = buildNumberAt(yield* Clock.currentTimeMillis);
    const asc = yield* makeAppStoreConnect(key);
    const mobile = path.join(
      yield* path.fromFileUrl(new URL("../", import.meta.url)),
      "apps/mobile",
    );
    const env = {
      APP_VARIANT: "production",
      CI: "1",
      EXPO_NO_GIT_STATUS: "1",
      T3CODE_IOS_BUILD_NUMBER: buildNumber,
      T3CODE_MOBILE_RUNTIME_VERSION: runtimeVersion,
      T3CODE_MOBILE_UPDATES_URL: updatesUrl.href,
    };
    const expo = path.join(mobile, "node_modules/.bin/expo");
    const { ios } = yield* decodeExpoConfig(
      yield* run(expo, ["config", "--type", "public", "--json"], {
        cwd: mobile,
        env,
        capture: true,
      }),
    );

    const [app] = (yield* decodeApps(
      yield* asc(
        HttpClientRequest.get("/v1/apps").pipe(
          HttpClientRequest.setUrlParams({ "filter[bundleId]": ios.bundleIdentifier }),
        ),
      ),
    )).data;
    if (!app)
      return yield* new TestFlightError({
        message: `No App Store Connect app exists for ${ios.bundleIdentifier}.`,
      });
    const builds = (params: Record<string, string>) =>
      asc(
        HttpClientRequest.get("/v1/builds").pipe(
          HttpClientRequest.setUrlParams({
            "filter[app]": app.id,
            include: "betaBuildLocalizations",
            "fields[builds]": "version,uploadedDate,expired,processingState,betaBuildLocalizations",
            ...params,
          }),
        ),
      ).pipe(Effect.flatMap(decodeBuilds));

    const current = findCurrentBuild(
      yield* builds({ sort: "-uploadedDate", limit: "50" }),
      runtimeVersion,
      yield* Clock.currentTimeMillis,
    );
    if (current && !force) {
      yield* Console.log(
        `TestFlight build ${current.attributes.version} already serves runtime ${runtimeVersion}; skipping.`,
      );
      return;
    }

    yield* run(expo, ["prebuild", "--clean", "--platform", "ios"], { cwd: mobile, env });
    const iosDir = path.join(mobile, "ios");
    const workspace = (yield* fs.readDirectory(iosDir)).find((entry) =>
      entry.endsWith(".xcworkspace"),
    );
    if (!workspace)
      return yield* new TestFlightError({ message: "Prebuild produced no Xcode workspace." });
    const scheme = path.basename(workspace, ".xcworkspace");
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-testflight-" });
    const archive = path.join(scratch, `${scheme}.xcarchive`);
    const optionsPlist = path.join(scratch, "ExportOptions.plist");
    yield* fs.writeFileString(optionsPlist, exportOptions(ios.appleTeamId));
    const authentication = [
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      key.path,
      "-authenticationKeyID",
      key.id,
      "-authenticationKeyIssuerID",
      key.issuer,
    ];

    yield* run(
      "xcodebuild",
      [
        "archive",
        "-quiet",
        "-workspace",
        path.join(iosDir, workspace),
        "-scheme",
        scheme,
        "-configuration",
        "Release",
        "-destination",
        "generic/platform=iOS",
        "-archivePath",
        archive,
        ...authentication,
        `DEVELOPMENT_TEAM=${ios.appleTeamId}`,
        "CODE_SIGN_STYLE=Automatic",
        `CURRENT_PROJECT_VERSION=${buildNumber}`,
      ],
      { cwd: mobile, env },
    );
    yield* run(
      "xcodebuild",
      [
        "-exportArchive",
        "-archivePath",
        archive,
        "-exportOptionsPlist",
        optionsPlist,
        "-exportPath",
        path.join(scratch, "export"),
        ...authentication,
      ],
      { cwd: mobile, env },
    );
    yield* Console.log(`Uploaded build ${buildNumber}; waiting for App Store Connect to list it.`);

    const uploaded = yield* builds({ "filter[version]": buildNumber }).pipe(
      Effect.flatMap((page) =>
        page.data[0]
          ? Effect.succeed({ build: page.data[0], localizations: page.included ?? [] })
          : Effect.fail(
              new TestFlightError({ message: `Build ${buildNumber} is not listed yet.` }),
            ),
      ),
      Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 60 }),
    );
    const whatsNew = `${notes}\n\n${runtimeNote(runtimeVersion)}`;
    const existing = uploaded.localizations.find(
      (entry) =>
        entry.attributes.locale === "en-US" &&
        uploaded.build.relationships.betaBuildLocalizations.data.some(({ id }) => id === entry.id),
    );
    yield* asc(
      existing
        ? yield* HttpClientRequest.patch(`/v1/betaBuildLocalizations/${existing.id}`).pipe(
            HttpClientRequest.bodyJson({
              data: { type: "betaBuildLocalizations", id: existing.id, attributes: { whatsNew } },
            }),
          )
        : yield* HttpClientRequest.post("/v1/betaBuildLocalizations").pipe(
            HttpClientRequest.bodyJson({
              data: {
                type: "betaBuildLocalizations",
                attributes: { locale: "en-US", whatsNew },
                relationships: { build: { data: { type: "builds", id: uploaded.build.id } } },
              },
            }),
          ),
    );
    yield* Console.log(`TestFlight build ${buildNumber} now serves runtime ${runtimeVersion}.`);
  }, Effect.scoped),
).pipe(Command.withDescription("Upload a TestFlight build when the runtime version needs one."));

if (import.meta.main) {
  Command.run(releaseCommand, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
