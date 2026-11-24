// @effect-diagnostics nodeBuiltinImport:off -- builds a thread world on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { looseFiles } from "./looseFiles.ts";

describe("looseFiles", () => {
  it("counts what a world repo at the root doesn't track, and skips the repos below it", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "world-"));
    using _cleanup = { [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true }) };
    const write = (path: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, path), "x");
    };
    for (const path of [
      ".git/HEAD",
      "AGENTS.md",
      "agent-notes/tracked.md",
      "agent-notes/new.md",
      "scratch.txt",
      "Repos/cloud/frontend/.git",
      "Repos/cloud/frontend/src/app.ts",
    ]) {
      write(path);
    }
    const tracked = new Set(["AGENTS.md", "agent-notes/tracked.md"]);
    expect(looseFiles(root, { tracked }).toSorted()).toEqual(["agent-notes/new.md", "scratch.txt"]);
    expect(looseFiles(root)).toEqual([]);
  });
});
