import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  codexOverloadRetry,
  codexOverloadRetryMessageId,
  codexResumableRunId,
  isCodexRunActive,
  isMessageFreeTurn,
} from "./codexTurnContinuation.ts";

const threadId = ThreadId.make("thread:continuation");
const codexInstance = ProviderInstanceId.make("codex");
const codexThread = ProviderThreadId.make("provider-thread:codex");
const claudeThread = ProviderThreadId.make("provider-thread:claude");
const failedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

function run(
  ordinal: number,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run {
  const id = RunId.make(`run:${ordinal}`);
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: codexInstance,
    modelSelection: { instanceId: codexInstance, model: "gpt-5.4" },
    providerThreadId: codexThread,
    userMessageId: MessageId.make(`message:${ordinal}`),
    rootNodeId: NodeId.make(`node:${ordinal}`),
    activeAttemptId: null,
    status,
    requestedAt: failedAt,
    startedAt: failedAt,
    completedAt: status === "running" ? null : failedAt,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

/** The automatic retry of `previous`, linked the way the server worker dispatches it. */
function retryOf(previous: OrchestrationV2Run, status: OrchestrationV2Run["status"] = "failed") {
  return run(previous.ordinal + 1, status, {
    userMessageId: codexOverloadRetryMessageId(previous.id),
  });
}

function failure(target: OrchestrationV2Run, code: string): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`error:${target.id}`),
    threadId,
    runId: target.id,
    nodeId: target.rootNodeId,
    providerThreadId: target.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: target.ordinal * 10 + 1,
    status: "failed",
    title: "Provider error",
    startedAt: failedAt,
    completedAt: failedAt,
    updatedAt: failedAt,
    type: "error",
    failure: {
      class: code === "usageLimitExceeded" ? "usage_limit" : "provider_error",
      message: "Selected model is at capacity.",
      code,
      retryable: null,
    },
  };
}

function assistantOutput(target: OrchestrationV2Run): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`assistant:${target.id}`),
    threadId,
    runId: target.id,
    nodeId: target.rootNodeId,
    providerThreadId: target.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: target.ordinal * 10,
    status: "completed",
    title: null,
    startedAt: failedAt,
    completedAt: failedAt,
    updatedAt: failedAt,
    type: "assistant_message",
    messageId: MessageId.make(`assistant:${target.id}`),
    text: "Partial answer",
    streaming: false,
  };
}

function projection(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  return {
    thread: { modelSelection: { instanceId: codexInstance, model: "gpt-5.4" } },
    runs,
    turnItems,
    providerThreads: [
      { id: codexThread, driver: ProviderDriverKind.make("codex") },
      { id: claudeThread, driver: ProviderDriverKind.make("claudeAgent") },
    ],
  };
}

/** A user turn that failed on overload, followed by `retries` automatic retries that failed too. */
function overloadChain(retries: number) {
  const runs = [run(1, "failed")];
  for (let index = 0; index < retries; index += 1) runs.push(retryOf(runs.at(-1)!));
  return { runs, failures: runs.map((candidate) => failure(candidate, "serverOverloaded")) };
}

describe("isMessageFreeTurn", () => {
  it.each([
    ["an empty message", true, { text: " ", attachments: [] }],
    ["typed text", false, { text: "Keep going", attachments: [] }],
    ["an attachment", false, { text: "", attachments: [{}] }],
    ["composer context", false, { text: "", attachments: [], context: { records: [{}] } }],
  ] as const)("%s: %s", (_case, expected, message) => {
    expect(isMessageFreeTurn(message)).toBe(expected);
  });
});

describe("codexResumableRunId", () => {
  it.each([
    ["an interrupted turn", run(1, "interrupted"), [], true],
    ["an overloaded model", run(1, "failed"), ["serverOverloaded"], true],
    ["a usage limit", run(1, "failed"), ["usageLimitExceeded"], true],
    ["another provider error", run(1, "failed"), ["contextWindowExceeded"], false],
    ["a completed turn", run(1, "completed"), [], false],
    ["a non-Codex provider", run(1, "interrupted", { providerThreadId: claudeThread }), [], false],
    [
      "a thread switched to another account",
      run(1, "interrupted", { providerInstanceId: ProviderInstanceId.make("codex_personal") }),
      [],
      false,
    ],
  ] as const)("resumes %s: %s", (_case, latest, codes, expected) => {
    const items = codes.map((code) => failure(latest, code));
    expect(codexResumableRunId(projection([latest], items))).toBe(expected ? latest.id : null);
  });
});

describe("isCodexRunActive", () => {
  it("offers Pause only while Codex works", () => {
    expect(isCodexRunActive(projection([run(1, "running")], []))).toBe(true);
    expect(isCodexRunActive(projection([run(1, "interrupted")], []))).toBe(false);
    expect(
      isCodexRunActive(projection([run(1, "running", { providerThreadId: claudeThread })], [])),
    ).toBe(false);
  });
});

describe("codexOverloadRetry", () => {
  it("schedules five retries with doubling waits from each failure", () => {
    const waits = [0, 1, 2, 3, 4].map((retries) => {
      const chain = overloadChain(retries);
      const retry = codexOverloadRetry(projection(chain.runs, chain.failures));
      expect(retry).toMatchObject({ phase: "scheduled", attempt: retries + 1 });
      if (retry?.phase !== "scheduled") throw new Error("expected a scheduled retry");
      expect(retry.runId).toBe(chain.runs.at(-1)!.id);
      return DateTime.toEpochMillis(retry.retryAt) - DateTime.toEpochMillis(failedAt);
    });
    [5_000, 10_000, 20_000, 40_000, 80_000].forEach((nominal, index) => {
      expect(waits[index]).toBeGreaterThanOrEqual(nominal * 0.8);
      expect(waits[index]).toBeLessThanOrEqual(nominal * 1.2);
    });
  });

  it("stops after the fifth retry fails", () => {
    const chain = overloadChain(5);
    expect(codexOverloadRetry(projection(chain.runs, chain.failures))).toEqual({
      phase: "exhausted",
      runId: chain.runs.at(-1)!.id,
    });
  });

  it("starts a new sequence after a retry makes progress", () => {
    const chain = overloadChain(5);
    const progressed = chain.runs.at(-1)!;
    expect(
      codexOverloadRetry(projection(chain.runs, [...chain.failures, assistantOutput(progressed)])),
    ).toMatchObject({ phase: "scheduled", attempt: 1, runId: progressed.id });
  });

  it("starts a new sequence after a manual Resume fails again", () => {
    const chain = overloadChain(5);
    const manual = run(7, "failed", { userMessageId: MessageId.make("message:manual-resume") });
    expect(
      codexOverloadRetry(
        projection(
          [...chain.runs, manual],
          [...chain.failures, failure(manual, "serverOverloaded")],
        ),
      ),
    ).toMatchObject({ phase: "scheduled", attempt: 1, runId: manual.id });
  });

  it("ignores other failures, other providers, and newer work", () => {
    const failed = run(1, "failed");
    const claude = run(1, "failed", { providerThreadId: claudeThread });
    expect(
      codexOverloadRetry(projection([failed], [failure(failed, "contextWindowExceeded")])),
    ).toBeNull();
    expect(codexOverloadRetry(projection([claude], [failure(claude, "serverOverloaded")]))).toBe(
      null,
    );
    expect(
      codexOverloadRetry(
        projection([failed, run(2, "running")], [failure(failed, "serverOverloaded")]),
      ),
    ).toBeNull();
  });
});
