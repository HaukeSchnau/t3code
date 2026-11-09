// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { findRepositoryMarker } from "./RepositoryMarker.ts";

it("rethrows a .jj probe error other than a missing or unreadable entry", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-repository-marker-"));
  try {
    NodeFS.symlinkSync(".jj", NodePath.join(root, ".jj"));
    expect(() => findRepositoryMarker(root)).toThrow(/ELOOP/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
