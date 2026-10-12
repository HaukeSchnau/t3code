import { ThreadId, TurnItemId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { openCodeToolTurnItem } from "./OpenCodeToolItems.ts";

const base = {
  id: TurnItemId.make("item"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running" as const,
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
};

const patchText = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  "@@",
  "-a",
  "+b",
  "*** Update File: src/old.ts",
  "*** Move to: src/new.ts",
  "*** Add File: src/c.ts",
  "+c",
  "*** Delete File: src/d.ts",
  "*** End Patch",
].join("\n");

describe("openCodeToolTurnItem", () => {
  it("names every file of a running apply_patch from its headers", () => {
    const item = openCodeToolTurnItem(base, {
      name: "apply_patch",
      input: { patchText },
      output: undefined,
      completedMetadata: undefined,
    });
    assert.deepInclude(item, {
      fileName: "src/a.ts",
      changes: [
        { operation: "update", path: "src/a.ts" },
        { operation: "move", path: "src/new.ts", oldPath: "src/old.ts" },
        { operation: "add", path: "src/c.ts" },
        { operation: "delete", path: "src/d.ts" },
      ],
    });
  });

  it("prefers the finished apply_patch metadata", () => {
    const item = openCodeToolTurnItem(base, {
      name: "apply_patch",
      input: { patchText },
      output: "Success.",
      completedMetadata: {
        diff: "diff",
        files: [
          { filePath: "/w/src/a.ts", relativePath: "src/a.ts", type: "update" },
          {
            filePath: "/w/src/old.ts",
            relativePath: "src/new.ts",
            type: "move",
            movePath: "/w/src/new.ts",
          },
        ],
      },
    });
    assert.deepInclude(item, {
      fileName: "/w/src/a.ts",
      changes: [
        { operation: "update", path: "/w/src/a.ts" },
        { operation: "move", path: "/w/src/new.ts", oldPath: "/w/src/old.ts" },
      ],
    });
  });

  it("reports the bash workdir as the command cwd", () => {
    const item = openCodeToolTurnItem(base, {
      name: "bash",
      input: { command: "ls", workdir: "/w/sub" },
      output: undefined,
      completedMetadata: undefined,
    });
    assert.deepInclude(item, { type: "command_execution", input: "ls", cwd: "/w/sub" });
  });
});
