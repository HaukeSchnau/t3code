// @effect-diagnostics nodeBuiltinImport:off -- project registrations use the launcher's SHA-256 contract.
import * as NodeCrypto from "node:crypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./assets/AssetAccess.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import { resolveAttachmentPath } from "./attachmentStore.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { snapshotObservedImage } from "./observedImageSnapshot.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-observed-image-test-",
});
const testLayer = Layer.mergeAll(
  NodeHttpPlatform.layer,
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(configLayer)),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

const threadId = ThreadId.make("thread-observed-image");

const snapshot = (path: string, options?: { cwd?: string; agentExecState?: string }) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* snapshotObservedImage({
      fileSystem: yield* FileSystem.FileSystem,
      attachmentsDir: config.attachmentsDir,
      threadId,
      path,
      cwd: options?.cwd ?? null,
      agentExecState: options?.agentExecState,
    });
  });

const readSnapshot = (attachment: ChatAttachment) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
    expect(path).not.toBeNull();
    return Array.from(yield* (yield* FileSystem.FileSystem).readFile(path!));
  });

describe("snapshotObservedImage", () => {
  it.effect("keeps the image as it was viewed after the original changes or disappears", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-viewed-" });
      const source = path.join(directory, "screen.png");
      yield* fileSystem.writeFile(source, new Uint8Array([137, 80, 78, 71, 1]));

      const first = yield* snapshot(source);
      expect(first).toMatchObject({
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 5,
      });
      expect((yield* snapshot(source))?.id).toBe(first?.id);

      yield* fileSystem.writeFile(source, new Uint8Array([137, 80, 78, 71, 2]));
      const second = yield* snapshot(source);
      expect(second?.id).not.toBe(first?.id);
      yield* fileSystem.remove(source);

      expect(yield* readSnapshot(first!)).toEqual([137, 80, 78, 71, 1]);
      expect(yield* readSnapshot(second!)).toEqual([137, 80, 78, 71, 2]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("serves the copy through a signed attachment URL", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-viewed-" });
      const source = path.join(directory, "diagram.webp");
      yield* fileSystem.writeFile(source, new Uint8Array([82, 73, 70, 70]));
      const attachment = yield* snapshot(source);
      expect(attachment).toBeDefined();

      const issued = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId: attachment!.id },
      });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const token = suffix.slice(0, suffix.indexOf("/"));
      expect(yield* resolveAsset(token, "diagram.webp")).toEqual({
        kind: "file",
        path: resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: attachment!,
        }),
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("skips files that are not previewable images, too large, or missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-viewed-" });
      const notes = path.join(directory, "notes.txt");
      yield* fileSystem.writeFileString(notes, "not an image");
      const huge = path.join(directory, "huge.png");
      yield* fileSystem.writeFile(huge, new Uint8Array([1]));
      yield* fileSystem.truncate(huge, 10 * 1024 * 1024 + 1);

      expect(yield* snapshot(notes)).toBeUndefined();
      expect(yield* snapshot(huge)).toBeUndefined();
      expect(yield* snapshot(path.join(directory, "gone.png"))).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reads an image from a separate project's namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-separate-project-" }),
      );
      const state = path.join(root, "registry");
      const id = NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 20);
      yield* fileSystem.makeDirectory(path.join(state, "projects"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(state, "projects", `${id}.json`),
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ root: Schema.String })))({
          root,
        }),
      );
      const scratch = path.join(state, "environments", id, "tmp");
      yield* fileSystem.makeDirectory(scratch, { recursive: true });
      yield* fileSystem.writeFile(path.join(scratch, "private.png"), new Uint8Array([9, 9, 9]));

      const attachment = yield* snapshot("/tmp/private.png", { cwd: root, agentExecState: state });
      expect(attachment).toMatchObject({ name: "private.png", sizeBytes: 3 });
      expect(yield* readSnapshot(attachment!)).toEqual([9, 9, 9]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
