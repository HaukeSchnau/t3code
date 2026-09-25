import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import {
  ASSET_GRACE_MS,
  RUNTIME_RETENTION_MS,
  describeAsset,
  selectPrunable,
} from "./mobile-update.ts";

const manifestUrl = new URL("https://updates.example/manifest");

it("addresses assets the way Expo Updates verifies and resolves them", () => {
  const bytes = new TextEncoder().encode("icon");
  const { storedName, asset } = describeAsset(bytes, "png", false, manifestUrl);
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest();

  assert.strictEqual(storedName, `${sha256.toString("hex")}.png`);
  assert.strictEqual(asset.url, `https://updates.example/assets/${storedName}`);
  // Clients verify the base64url SHA-256; the bundle looks assets up by Metro's MD5.
  assert.strictEqual(asset.hash, sha256.toString("base64url"));
  assert.strictEqual(asset.key, NodeCrypto.createHash("md5").update(bytes).digest("hex"));
  assert.strictEqual(asset.contentType, "image/png");
});

it("prunes stale runtimes and only the assets nothing else still references", () => {
  const nowMs = 100 * RUNTIME_RETENTION_MS;
  const old = nowMs - RUNTIME_RETENTION_MS - 1;
  const prunable = selectPrunable({
    nowMs,
    manifests: [
      {
        path: "ios/current/manifest.json",
        modifiedAtMs: nowMs,
        assetNames: ["shared.png", "new.hbc"],
      },
      {
        path: "ios/retired/manifest.json",
        modifiedAtMs: old,
        assetNames: ["shared.png", "old.hbc"],
      },
    ],
    assets: [
      { name: "shared.png", modifiedAtMs: old },
      { name: "new.hbc", modifiedAtMs: nowMs },
      { name: "old.hbc", modifiedAtMs: old },
      // Written by a publish whose manifest has not landed yet.
      { name: "in-flight.hbc", modifiedAtMs: nowMs - ASSET_GRACE_MS + 1 },
    ],
  });

  assert.deepStrictEqual(prunable, {
    manifests: ["ios/retired/manifest.json"],
    assets: ["old.hbc"],
  });
});
