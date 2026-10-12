import type { JjStackEntry, JjStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { jjPushState, jjStackViewFromStatus } from "./jj-stack-presentation";

const entry = (overrides: Partial<JjStackEntry>): JjStackEntry => ({
  changeId: "kxqvmpstrylwnzoutsnmpoqkvwuzxlmn",
  commitId: "0123456789abcdef0123456789abcdef01234567",
  description: "feat: add parser",
  empty: false,
  conflict: false,
  workingCopy: true,
  bookmarks: [],
  pushed: false,
  threadId: null,
  turns: [],
  flags: [],
  ...overrides,
});

const jj = (stack: ReadonlyArray<JjStackEntry>): JjStatus => ({
  operationId: "op",
  trunk: { changeId: "zzzz", label: "main@origin" },
  stack,
  conflictedFiles: [],
  unattributed: [],
});

const pushStateOf = (stack: ReadonlyArray<JjStackEntry>) => {
  const view = jjStackViewFromStatus({ kind: "jj", jj: jj(stack) }, null);
  if (view === null) throw new Error("expected a jj stack");
  return jjPushState(view);
};

describe("jjStackViewFromStatus", () => {
  it("keeps Git and older servers on the Git controls", () => {
    expect(jjStackViewFromStatus({ kind: "git" }, null)).toBeNull();
    expect(jjStackViewFromStatus({}, null)).toBeNull();
    expect(jjStackViewFromStatus({ kind: "jj" }, null)).toBeNull();
    expect(jjStackViewFromStatus({ kind: "jj", jj: jj([entry({})]) }, null)).not.toBeNull();
  });
});

describe("jjPushState", () => {
  it("describes where Push lands", () => {
    expect(pushStateOf([entry({ empty: true })])).toBe("Nothing to push");
    expect(pushStateOf([entry({})])).toBe("Not pushed");
    expect(pushStateOf([entry({ bookmarks: ["t3code/parser"] })])).toBe(
      "t3code/parser · not pushed",
    );
    expect(pushStateOf([entry({ bookmarks: ["t3code/parser"], pushed: true })])).toBe(
      "t3code/parser",
    );
  });
});
