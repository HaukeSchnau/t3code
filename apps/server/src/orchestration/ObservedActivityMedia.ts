import type {
  OrchestrationActivityImageMedia,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import Mime from "@effect/platform-node/Mime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";
import { createObservedMediaId, resolveObservedMediaPath } from "../observedMediaStore.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function observedImageSourcePath(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (payload?.itemType !== "image_view") return null;
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  return (
    asString(item?.path) ??
    asString(item?.savedPath) ??
    asString(data?.path) ??
    asString(data?.savedPath) ??
    asString(payload.detail)
  );
}

function isLocalPath(sourcePath: string): boolean {
  const normalizedPath = sourcePath.trim().toLowerCase();
  return (
    normalizedPath.length > 0 &&
    !normalizedPath.startsWith("data:") &&
    !normalizedPath.startsWith("http://") &&
    !normalizedPath.startsWith("https://")
  );
}

function existingMedia(
  payload: Record<string, unknown>,
): ReadonlyArray<OrchestrationActivityImageMedia> {
  if (!Array.isArray(payload.media)) return [];
  return payload.media.flatMap((item): ReadonlyArray<OrchestrationActivityImageMedia> => {
    const record = asRecord(item);
    const id = asString(record?.id);
    const name = asString(record?.name);
    const mimeType = asString(record?.mimeType);
    const storageId = asString(record?.storageId);
    if (record?.type !== "image" || !id || !name || !mimeType || !storageId) return [];
    const sizeBytes = asFiniteNumber(record.sizeBytes);
    const originalPath = asString(record.originalPath);
    return [
      {
        type: "image",
        id,
        name,
        mimeType,
        storageId,
        ...(sizeBytes !== null ? { sizeBytes } : {}),
        ...(originalPath ? { originalPath } : {}),
      },
    ];
  });
}

export const makeObservedActivityMedia = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const enrich = (input: {
    readonly activity: OrchestrationThreadActivity;
    readonly threadId: ThreadId;
  }): Effect.Effect<OrchestrationThreadActivity> =>
    Effect.gen(function* () {
      const payload = asRecord(input.activity.payload);
      const sourcePath = observedImageSourcePath(input.activity);
      if (!payload || !sourcePath || !isLocalPath(sourcePath)) return input.activity;

      const mimeType = Mime.getType(sourcePath);
      if (!mimeType?.toLowerCase().startsWith("image/")) return input.activity;
      const mediaId = createObservedMediaId(input.threadId);
      if (!mediaId) return input.activity;

      const bytes = yield* fileSystem.readFile(sourcePath);
      const extension = inferImageExtension({ mimeType, fileName: sourcePath });
      const targetPath = resolveObservedMediaPath({
        observedMediaDir: serverConfig.observedMediaDir,
        mediaId,
        extension,
      });
      if (!targetPath) return input.activity;

      yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true });
      yield* fileSystem.writeFile(targetPath, bytes);
      const observedMedia: OrchestrationActivityImageMedia = {
        type: "image",
        id: mediaId,
        name: path.basename(sourcePath) || "image",
        mimeType,
        storageId: mediaId,
        sizeBytes: bytes.byteLength,
        originalPath: sourcePath,
      };
      return {
        ...input.activity,
        payload: { ...payload, media: [...existingMedia(payload), observedMedia] },
      };
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to persist observed image for work-log preview", {
          cause,
          activityId: input.activity.id,
        }),
      ),
      Effect.orElseSucceed(() => input.activity),
    );

  return { enrich } as const;
});
