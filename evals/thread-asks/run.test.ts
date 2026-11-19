import { describe, expect, it } from "vite-plus/test";
import { casePasses, gradeThreadAsk } from "./grade.ts";

const waiting = { waits: true, ask: /delet/i };
const control = { waits: false };

describe("gradeThreadAsk", () => {
  it.each([
    [waiting, { waitsOnUser: true, ask: "Delete 23 leftover dirs on 4 hosts?" }, null],
    [waiting, { waitsOnUser: false, ask: "" }, "missed that the turn waits"],
    [waiting, { waitsOnUser: true, ask: "" }, "waits, but gave no ask"],
    [
      waiting,
      { waitsOnUser: true, ask: "x".repeat(121) },
      "ask is not one line under 120 characters",
    ],
    [
      waiting,
      { waitsOnUser: true, ask: "The agent wants to delete dirs" },
      "ask describes the agent instead of the user's step",
    ],
    [waiting, { waitsOnUser: true, ask: "Pick a layout" }, "ask does not name the subject"],
    [control, { waitsOnUser: false, ask: "" }, null],
    [
      control,
      { waitsOnUser: true, ask: "Merge it?" },
      "marked a turn that does not wait as waiting",
    ],
  ] as const)("grades %o against %o", (testCase, result, reason) => {
    expect(gradeThreadAsk(testCase, result)).toEqual({ pass: reason === null, reason });
  });

  it("fails a case when half or more of its samples fail or error", () => {
    const pass = { pass: true, reason: null };
    const fail = { pass: false, reason: "missed" };
    const errored = { pass: false, reason: null, error: "overloaded" };
    expect(casePasses([pass, pass, fail])).toBe(true);
    expect(casePasses([pass, fail])).toBe(false);
    expect(casePasses([pass, errored, errored])).toBe(false);
    expect(casePasses([])).toBe(false);
  });
});
