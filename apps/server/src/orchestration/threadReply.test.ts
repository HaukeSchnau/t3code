import type { OrchestrationThreadActivity, UserInputQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchUserInputAnswer, planThreadReply } from "./threadReply.ts";

const question = (overrides: Partial<UserInputQuestion> = {}): UserInputQuestion => ({
  id: "runner",
  header: "Runner",
  question: "Which runner should the new package use?",
  options: [
    { label: "Vitest", description: "" },
    { label: "Bun test", description: "" },
    { label: "node:test", description: "", value: "node" },
  ],
  multiSelect: false,
  ...overrides,
});

const questionRequest = (
  requestId: string,
  questions: ReadonlyArray<UserInputQuestion>,
): OrchestrationThreadActivity =>
  ({
    kind: "user-input.requested",
    payload: { requestId, questions },
  }) as OrchestrationThreadActivity;

const waiting = (openRequests: ReadonlyArray<OrchestrationThreadActivity>, text = "Vitest") =>
  planThreadReply({ text, hasPendingApprovals: false, hasPendingUserInput: true, openRequests });

describe("planThreadReply", () => {
  it("sends a message when nothing is pending", () => {
    expect(
      planThreadReply({
        text: "Push it",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        openRequests: [],
      }),
    ).toEqual({ _tag: "Message" });
  });

  it("refuses to answer around a pending approval", () => {
    expect(
      planThreadReply({
        text: "yes",
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        openRequests: [questionRequest("req-1", [question()])],
      }),
    ).toEqual({ _tag: "Rejected", reason: "approval_pending" });
  });

  it("answers the only pending question", () => {
    expect(waiting([questionRequest("req-1", [question()])], "vitest please")).toEqual({
      _tag: "Answer",
      requestId: "req-1",
      answers: { runner: "Vitest" },
    });
  });

  it("leaves multi-part and unreadable questions to the full client", () => {
    const rejected = { _tag: "Rejected", reason: "question_needs_client" };
    expect(waiting([questionRequest("req-1", [question(), question({ id: "other" })])])).toEqual(
      rejected,
    );
    expect(
      waiting([questionRequest("req-1", [question()]), questionRequest("req-2", [question()])]),
    ).toEqual(rejected);
    // The shell says a question is pending, but the activities don't show one.
    expect(waiting([])).toEqual(rejected);
  });

  it("rejects text that matches no option of a closed question", () => {
    expect(
      waiting([questionRequest("req-1", [question({ allowCustomAnswer: false })])], "Jest"),
    ).toEqual({ _tag: "Rejected", reason: "no_matching_option" });
  });
});

describe("matchUserInputAnswer", () => {
  it("submits the option value, like the composer", () => {
    expect(matchUserInputAnswer(question(), "node:test")).toBe("node");
    expect(matchUserInputAnswer(question(), "Bun test.")).toBe("Bun test");
  });

  it("understands positions, typed or dictated", () => {
    expect(matchUserInputAnswer(question(), "2")).toBe("Bun test");
    expect(matchUserInputAnswer(question(), "option three")).toBe("node");
    expect(matchUserInputAnswer(question(), "four")).toBe("four");
  });

  it("falls back to free text when the reply names no single option", () => {
    expect(matchUserInputAnswer(question(), "Vitest or Bun test, your call")).toBe(
      "Vitest or Bun test, your call",
    );
    expect(matchUserInputAnswer(question({ allowCustomAnswer: false }), "Jest")).toBeNull();
  });

  it("wraps matches for multi-select questions", () => {
    expect(matchUserInputAnswer(question({ multiSelect: true }), "vitest")).toEqual(["Vitest"]);
  });
});
