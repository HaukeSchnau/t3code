// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";
import {
  normalizeObservedMediaRelativePath,
  resolveObservedMediaRelativePath,
} from "./observedMediaPaths.ts";

const OBSERVED_MEDIA_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const OBSERVED_MEDIA_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const OBSERVED_MEDIA_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const OBSERVED_MEDIA_ID_UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OBSERVED_MEDIA_ID_PATTERN = new RegExp(
  `^(${OBSERVED_MEDIA_ID_THREAD_SEGMENT_PATTERN})-(${OBSERVED_MEDIA_ID_UUID_PATTERN})$`,
  "i",
);

export function toSafeObservedMediaThreadSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, OBSERVED_MEDIA_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  return segment.length > 0 ? segment : null;
}

export function createObservedMediaId(threadId: string): string | null {
  const threadSegment = toSafeObservedMediaThreadSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${randomUUID()}`;
}

export function observedMediaRelativePath(input: {
  readonly mediaId: string;
  readonly extension: string;
}): string | null {
  const normalizedId = normalizeObservedMediaRelativePath(input.mediaId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  if (!OBSERVED_MEDIA_ID_PATTERN.test(normalizedId)) {
    return null;
  }
  const extension = input.extension.startsWith(".") ? input.extension : `.${input.extension}`;
  const normalizedExtension = extension.toLowerCase();
  if (!OBSERVED_MEDIA_FILENAME_EXTENSIONS.includes(normalizedExtension)) {
    return null;
  }
  return `${normalizedId}${normalizedExtension}`;
}

export function resolveObservedMediaPath(input: {
  readonly observedMediaDir: string;
  readonly mediaId: string;
  readonly extension: string;
}): string | null {
  const relativePath = observedMediaRelativePath({
    mediaId: input.mediaId,
    extension: input.extension,
  });
  if (!relativePath) {
    return null;
  }
  return resolveObservedMediaRelativePath({
    observedMediaDir: input.observedMediaDir,
    relativePath,
  });
}

export function resolveObservedMediaPathById(input: {
  readonly observedMediaDir: string;
  readonly mediaId: string;
}): string | null {
  const normalizedId = normalizeObservedMediaRelativePath(input.mediaId);
  if (
    !normalizedId ||
    normalizedId.includes("/") ||
    normalizedId.includes(".") ||
    !OBSERVED_MEDIA_ID_PATTERN.test(normalizedId)
  ) {
    return null;
  }
  for (const extension of OBSERVED_MEDIA_FILENAME_EXTENSIONS) {
    const maybePath = resolveObservedMediaRelativePath({
      observedMediaDir: input.observedMediaDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}
