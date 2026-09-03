// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
    const observedMediaDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-observed-media-"),
    );
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
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveObservedMediaPathById({
        observedMediaDir,
        mediaId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(observedMediaDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid observed media ids and extensions", () => {
    const observedMediaDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-observed-media-"),
    );
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
      NodeFS.rmSync(observedMediaDir, { recursive: true, force: true });
    }
  });
});
