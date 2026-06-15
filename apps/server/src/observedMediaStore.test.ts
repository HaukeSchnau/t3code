// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createObservedMediaId,
  resolveObservedMediaPath,
  resolveObservedMediaPathById,
  toSafeObservedMediaThreadSegment,
} from "./observedMediaStore.ts";

describe("observedMediaStore", () => {
  it("sanitizes thread ids when creating observed media ids", () => {
    const mediaId = createObservedMediaId("thread.folder/unsafe space");
    expect(mediaId).toBeTruthy();
    if (!mediaId) {
      return;
    }

    const threadSegment = toSafeObservedMediaThreadSegment("thread.folder/unsafe space");
    expect(threadSegment).toBe("thread-folder-unsafe-space");
    expect(mediaId.startsWith(`${threadSegment}-`)).toBe(true);
    expect(mediaId).not.toContain(".");
    expect(mediaId).not.toContain("%");
    expect(mediaId).not.toContain("/");
  });

  it("resolves observed media path by id using the extension that exists on disk", () => {
    const observedMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-observed-media-"));
    try {
      const mediaId = "thread-11111111-1111-4111-8111-111111111111";
      const pngPath = resolveObservedMediaPath({
        observedMediaDir,
        mediaId,
        extension: ".png",
      });
      expect(pngPath).toBeTruthy();
      if (!pngPath) {
        return;
      }
      fs.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveObservedMediaPathById({
        observedMediaDir,
        mediaId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      fs.rmSync(observedMediaDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid observed media ids and extensions", () => {
    const observedMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-observed-media-"));
    try {
      expect(
        resolveObservedMediaPath({
          observedMediaDir,
          mediaId: "../escape-11111111-1111-4111-8111-111111111111",
          extension: ".png",
        }),
      ).toBeNull();
      expect(
        resolveObservedMediaPath({
          observedMediaDir,
          mediaId: "thread-11111111-1111-4111-8111-111111111111",
          extension: ".html",
        }),
      ).toBeNull();
    } finally {
      fs.rmSync(observedMediaDir, { recursive: true, force: true });
    }
  });
});
