// @effect-diagnostics nodeBuiltinImport:off -- namespace registration uses the launcher SHA-256 contract.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ThreadId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { resolveObservedMediaPath } from "../observedMediaStore.ts";
import { makeObservedActivityMedia } from "./ObservedActivityMedia.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-observed-activity-media-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("ObservedActivityMedia", () => {
  it.effect("copies local image-view media while preserving existing media", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const sourceDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-observed-source-",
      });
      const sourcePath = path.join(sourceDirectory, "preview.png");
      const sourceBytes = new Uint8Array([137, 80, 78, 71]);
      yield* fileSystem.writeFile(sourcePath, sourceBytes);

      const mediaPolicy = yield* makeObservedActivityMedia;
      const activity: OrchestrationThreadActivity = {
        id: EventId.make("activity-1"),
        tone: "tool",
        kind: "provider.item.updated",
        summary: "Viewed preview.png",
        payload: {
          itemType: "image_view",
          data: { item: { path: sourcePath } },
          media: [
            {
              type: "image",
              id: "existing-media",
              name: "existing.png",
              mimeType: "image/png",
              storageId: "existing-media",
            },
          ],
        },
        turnId: null,
        createdAt: "2026-08-09T00:00:00.000Z",
      };

      const enriched = yield* mediaPolicy.enrich({
        activity,
        threadId: ThreadId.make("thread-1"),
      });
      const payload = enriched.payload as {
        readonly media: ReadonlyArray<{
          readonly storageId: string;
          readonly originalPath?: string;
          readonly sizeBytes?: number;
        }>;
      };
      expect(payload.media).toHaveLength(2);
      expect(payload.media[0]?.storageId).toBe("existing-media");
      const observed = payload.media[1];
      expect(observed).toMatchObject({
        originalPath: sourcePath,
        sizeBytes: sourceBytes.byteLength,
      });

      const targetPath = resolveObservedMediaPath({
        observedMediaDir: config.observedMediaDir,
        mediaId: observed?.storageId ?? "",
        extension: "png",
      });
      expect(targetPath).not.toBeNull();
      expect(Array.from(yield* fileSystem.readFile(targetPath ?? ""))).toEqual(
        Array.from(sourceBytes),
      );
    }).pipe(Effect.provide(configLayer)),
  );
  it.effect("persists a private namespace image using the thread workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-private-image-" });
      const root = yield* fs.realPath(base);
      const state = path.join(root, "registry");
      const id = NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 20);
      yield* fs.makeDirectory(path.join(state, "projects"), { recursive: true });
      yield* fs.writeFileString(
        path.join(state, "projects", `${id}.json`),
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ root: Schema.String })))({
          root,
        }),
      );
      const scratch = path.join(state, "environments", id, "tmp");
      yield* fs.makeDirectory(scratch, { recursive: true });
      const bytes = new Uint8Array([137, 80, 78, 71, 42]);
      yield* fs.writeFile(path.join(scratch, "private.png"), bytes);
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const old = process.env.AGENT_EXEC_STATE;
          process.env.AGENT_EXEC_STATE = state;
          return old;
        }),
        (old) =>
          Effect.sync(() => {
            if (old === undefined) delete process.env.AGENT_EXEC_STATE;
            else process.env.AGENT_EXEC_STATE = old;
          }),
      );
      const policy = yield* makeObservedActivityMedia;
      const enriched = yield* policy.enrich({
        threadId: ThreadId.make("private-image-thread"),
        resolveWorkspaceRoot: Effect.succeed(root),
        activity: {
          id: EventId.make("private-image"),
          tone: "tool",
          kind: "provider.item.updated",
          summary: "Viewed private.png",
          turnId: null,
          createdAt: "2026-09-09T10:00:00.000Z",
          payload: { itemType: "image_view", data: { item: { path: "/tmp/private.png" } } },
        },
      });
      expect(enriched.payload).toMatchObject({
        media: [{ originalPath: "/tmp/private.png", sizeBytes: 5 }],
      });
      const files = yield* fs.readDirectory(config.observedMediaDir);
      expect(files.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(configLayer)),
  );
});
