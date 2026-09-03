import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ThreadId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

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
});
