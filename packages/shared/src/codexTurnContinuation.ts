import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { latestExecutedRun, latestRootProviderFailure } from "./orchestrationV2ThreadError.ts";

/** Automatic retries after Codex reports the selected model at capacity. */
const CODEX_OVERLOAD_RETRY_LIMIT = 5;

const FIRST_RETRY_DELAY_MS = 5_000;
const RETRY_JITTER_RATIO = 0.2;
const OVERLOAD_RETRY_MESSAGE_PREFIX = "codex-overload-retry:";

interface ContinuationProjection {
  readonly thread: Pick<OrchestrationV2AppThread, "modelSelection">;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "driver">>;
}

type CodexOverloadRetry =
  | {
      readonly phase: "scheduled";
      /** The failed run the retry continues. */
      readonly runId: RunId;
      readonly attempt: number;
      readonly retryAt: DateTime.Utc;
    }
  | { readonly phase: "exhausted"; readonly runId: RunId };

/**
 * A turn without prompt content. Codex receives it as `turn/start` with no
 * input and continues from its own thread context, so it adds no message.
 */
export function isMessageFreeTurn(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
  readonly context?: { readonly records: ReadonlyArray<unknown> } | undefined;
}): boolean {
  return (
    message.text.trim() === "" &&
    message.attachments.length === 0 &&
    (message.context?.records.length ?? 0) === 0
  );
}

/** Codex ends a turn this way when the model is at capacity and it will not retry itself. */
export function isCodexOverloadFailure(failure: OrchestrationV2ProviderFailure | null): boolean {
  return failure?.code === "serverOverloaded";
}

/** Whether the next turn of `run` can continue it without a message: Codex, on the same account. */
export function isCodexContinuationTarget(
  projection: Pick<ContinuationProjection, "thread" | "providerThreads">,
  run: Pick<OrchestrationV2Run, "providerThreadId" | "providerInstanceId">,
): boolean {
  return (
    projection.thread.modelSelection.instanceId === run.providerInstanceId &&
    projection.providerThreads.some(
      (thread) => thread.id === run.providerThreadId && thread.driver === "codex",
    )
  );
}

/** The message id of the automatic retry that continues `runId`; also its idempotency key. */
export function codexOverloadRetryMessageId(runId: RunId): MessageId {
  return MessageId.make(`${OVERLOAD_RETRY_MESSAGE_PREFIX}${runId}`);
}

/** Codex is working on a turn, so its interrupt is a pause. Workspace setup still stops. */
export function isCodexRunActive(projection: ContinuationProjection): boolean {
  return projection.runs.some(
    (run) =>
      (run.status === "starting" || run.status === "running" || run.status === "waiting") &&
      isCodexContinuationTarget(projection, run),
  );
}

/** The latest Codex run that Resume continues without adding a message. */
export function codexResumableRunId(projection: ContinuationProjection): RunId | null {
  const run = latestExecutedRun(projection.runs);
  if (run === null || !isCodexContinuationTarget(projection, run)) return null;
  if (run.status === "interrupted") return run.id;
  const failure = latestRootProviderFailure(run, projection.turnItems);
  return failure?.class === "usage_limit" || isCodexOverloadFailure(failure) ? run.id : null;
}

/** The runs whose turn items `codexOverloadRetry` reads, newest first. */
export function codexOverloadRetryRunIds(runs: ReadonlyArray<OrchestrationV2Run>): RunId[] {
  return executedRunsNewestFirst(runs)
    .slice(0, CODEX_OVERLOAD_RETRY_LIMIT + 1)
    .map((run) => run.id);
}

/**
 * Derives the automatic retry state from run history, so it needs no stored
 * timer and survives restarts. Each retry continues the failed run before it.
 * A retry that made progress, or a manual Resume, starts a new sequence.
 */
export function codexOverloadRetry(projection: ContinuationProjection): CodexOverloadRetry | null {
  const failed = latestExecutedRun(projection.runs);
  if (failed?.completedAt == null || !isOverloadedCodexRun(projection, failed)) return null;
  const runs = executedRunsNewestFirst(projection.runs);
  let failures = 1;
  while (failures <= CODEX_OVERLOAD_RETRY_LIMIT) {
    const retry = runs[failures - 1]!;
    const previous = runs[failures];
    if (
      previous === undefined ||
      retry.userMessageId !== codexOverloadRetryMessageId(previous.id) ||
      madeProgress(projection.turnItems, retry.id) ||
      !isOverloadedCodexRun(projection, previous)
    )
      break;
    failures += 1;
  }
  if (failures > CODEX_OVERLOAD_RETRY_LIMIT) return { phase: "exhausted", runId: failed.id };
  return {
    phase: "scheduled",
    runId: failed.id,
    attempt: failures,
    retryAt: DateTime.add(failed.completedAt, {
      milliseconds: overloadRetryDelayMs(failed.id, failures),
    }),
  };
}

export function codexOverloadRetryNotice(retry: CodexOverloadRetry | null): string | null {
  if (retry === null) return null;
  return retry.phase === "scheduled"
    ? `Retrying automatically, attempt ${retry.attempt} of ${CODEX_OVERLOAD_RETRY_LIMIT}. Resume to retry now.`
    : `Automatic retries stopped after ${CODEX_OVERLOAD_RETRY_LIMIT} attempts. Resume to try again.`;
}

function executedRunsNewestFirst(
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2Run> {
  return runs
    .filter(
      (run) => run.status !== "queued" && !(run.status === "cancelled" && run.startedAt === null),
    )
    .sort((left, right) => right.ordinal - left.ordinal);
}

function isOverloadedCodexRun(projection: ContinuationProjection, run: OrchestrationV2Run) {
  return (
    isCodexContinuationTarget(projection, run) &&
    isCodexOverloadFailure(latestRootProviderFailure(run, projection.turnItems))
  );
}

// Agent output resets the retry sequence; bookkeeping items such as the
// failure itself or a checkpoint do not.
const PROGRESS_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "todo_list",
  "user_input_request",
  "approval_request",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
]);

function madeProgress(turnItems: ReadonlyArray<OrchestrationV2TurnItem>, runId: RunId) {
  return turnItems.some((item) => item.runId === runId && PROGRESS_ITEM_TYPES.has(item.type));
}

// Stable jitter spreads retries of different threads without a stored seed.
function overloadRetryDelayMs(runId: RunId, attempt: number) {
  let hash = 2_166_136_261;
  for (let index = 0; index < runId.length; index += 1) {
    hash ^= runId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const jitter = 1 - RETRY_JITTER_RATIO + ((hash >>> 0) / 0xffff_ffff) * RETRY_JITTER_RATIO * 2;
  return Math.round(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1) * jitter);
}
