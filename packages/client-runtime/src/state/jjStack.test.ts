import { describe, expect, it } from "vite-plus/test";
import type { JjStackEntry, JjStatus } from "@t3tools/contracts";

import { buildJjStackView, formatJjTurns, jjBreadcrumbParts } from "./jjStack.ts";

const entry = (overrides: Partial<JjStackEntry>): JjStackEntry => ({
  changeId: "kxqvmpstrylwnzoutsnmpoqkvwuzxlmn",
  commitId: "0123456789abcdef0123456789abcdef01234567",
  description: "",
  empty: false,
  conflict: false,
  workingCopy: false,
  bookmarks: [],
  pushed: false,
  threadId: null,
  turns: [],
  flags: [],
  ...overrides,
});

const status = (stack: ReadonlyArray<JjStackEntry>): JjStatus => ({
  operationId: "op",
  trunk: { changeId: "zzzz", label: "main@origin" },
  stack,
  conflictedFiles: [],
  unattributed: [],
});

describe("formatJjTurns", () => {
  it("names one turn, a run of turns, or a list", () => {
    expect(formatJjTurns([])).toBeNull();
    expect(formatJjTurns([2])).toBe("turn 2");
    expect(formatJjTurns([3, 1, 2])).toBe("turns 1-3");
    expect(formatJjTurns([1, 3])).toBe("turns 1, 3");
  });
});

describe("buildJjStackView", () => {
  it("pushes the change below an empty working copy and counts only real changes", () => {
    const view = buildJjStackView(
      status([
        entry({ changeId: "tsnmaaaa", workingCopy: true, empty: true }),
        entry({
          changeId: "rylwbbbb",
          description: "feat: wire parser",
          threadId: "t1",
          turns: [2],
        }),
        entry({
          changeId: "kxqvcccc",
          description: "feat: add parser",
          threadId: "t2",
          turns: [1],
        }),
      ]),
      "t1",
    );
    expect(view.changeCount).toBe(2);
    expect(view.pushTarget?.changeId).toBe("rylwbbbb");
    expect(view.rows.map((row) => row.ownership)).toEqual([
      "untagged",
      "this-thread",
      "other-thread",
    ]);
    expect(jjBreadcrumbParts(view)).toEqual(["main@origin", "2 changes", "@ tsnm"]);
  });

  it("pushes a non-empty working copy itself", () => {
    const view = buildJjStackView(
      status([entry({ changeId: "tsnmaaaa", workingCopy: true, description: "wip" })]),
      null,
    );
    expect(view.pushTarget?.changeId).toBe("tsnmaaaa");
  });
});
