// @effect-diagnostics nodeBuiltinImport:off
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeOrchestrationIntegrationHarness } from "../OrchestrationEngineHarness.integration.ts";

export const HARD_KILL_READY_MARKER = "T3_COALESCING_HARD_KILL_READY";

export const HARD_KILL_THREAD_ID = ThreadId.make("coalescing-hard-kill-thread");
export const HARD_KILL_TURN_ID = TurnId.make("coalescing-hard-kill-turn");
const ITEM_ID = RuntimeItemId.make("coalescing-hard-kill-item");
const PARENT_ITEM_ID = RuntimeItemId.make("coalescing-hard-kill-parent-item");
const LARGE_ITEM_ID = RuntimeItemId.make("coalescing-hard-kill-large-item");
const LARGE_PREFIX = "s".repeat(24_001);
const PROVIDER = ProviderDriverKind.make("codex");
const AGENT_CONTEXT = {
  providerThreadId: "coalescing-hard-kill-child",
  parentTurnId: HARD_KILL_TURN_ID,
} as const;

export function hardKillDeltaEvent(input: {
  readonly eventId: string;
  readonly createdAt: string;
  readonly delta: string;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    eventId: EventId.make(input.eventId),
    provider: PROVIDER,
    threadId: HARD_KILL_THREAD_ID,
    turnId: HARD_KILL_TURN_ID,
    itemId: ITEM_ID,
    agentContext: AGENT_CONTEXT,
    createdAt: input.createdAt,
    payload: { streamKind: "assistant_text", delta: input.delta },
  };
}

export function hardKillTerminalEvent(): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    eventId: EventId.make("evt-coalescing-hard-kill-terminal"),
    provider: PROVIDER,
    threadId: HARD_KILL_THREAD_ID,
    turnId: HARD_KILL_TURN_ID,
    createdAt: "2026-07-13T00:00:01.000Z",
    payload: { state: "completed" },
  };
}

function hardKillParentDeltaEvent(input: {
  readonly eventId: string;
  readonly createdAt: string;
  readonly delta: string;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    eventId: EventId.make(input.eventId),
    provider: PROVIDER,
    threadId: HARD_KILL_THREAD_ID,
    turnId: HARD_KILL_TURN_ID,
    itemId: PARENT_ITEM_ID,
    createdAt: input.createdAt,
    payload: { streamKind: "assistant_text", delta: input.delta },
  };
}

function hardKillParentPauseEvent(): ProviderRuntimeEvent {
  return {
    type: "request.opened",
    eventId: EventId.make("evt-coalescing-hard-kill-parent-pause"),
    provider: PROVIDER,
    threadId: HARD_KILL_THREAD_ID,
    turnId: HARD_KILL_TURN_ID,
    requestId: RuntimeRequestId.make("req-coalescing-hard-kill-parent-pause"),
    createdAt: "2026-07-13T00:00:00.160Z",
    payload: { requestType: "command_execution_approval", detail: "pause" },
  };
}

export function subagentTranscript(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): string | null {
  const activity = thread.activities.find((candidate) => candidate.kind === "subagent.thread");
  if (activity === undefined || typeof activity.payload !== "object" || activity.payload === null) {
    return null;
  }
  const transcript = (activity.payload as Record<string, unknown>).transcript;
  return typeof transcript === "string" ? transcript : null;
}

const run = Effect.gen(function* () {
  const rootDir = process.argv[2];
  if (!rootDir) {
    return yield* Effect.die("Expected the persisted harness root directory argument.");
  }

  const harness = yield* makeOrchestrationIntegrationHarness({ rootDir });
  const adapter = harness.adapterHarness;
  if (adapter === null) {
    return yield* Effect.die("Expected the deterministic test provider adapter.");
  }

  yield* adapter.emitRuntimeEvent(
    hardKillDeltaEvent({
      eventId: "evt-coalescing-hard-kill-prefix",
      createdAt: "2026-07-13T00:00:00.000Z",
      delta: "durable prefix ",
    }),
  );
  yield* harness.waitForThread(
    HARD_KILL_THREAD_ID,
    (thread) => subagentTranscript(thread) === "durable prefix ",
  );

  yield* adapter.emitRuntimeEvent(
    hardKillParentDeltaEvent({
      eventId: "evt-coalescing-hard-kill-parent-prefix",
      createdAt: "2026-07-13T00:00:00.150Z",
      delta: "parent durable prefix ",
    }),
  );
  yield* adapter.emitRuntimeEvent({
    type: "task.started",
    eventId: EventId.make("evt-coalescing-hard-kill-buffering-barrier"),
    provider: PROVIDER,
    threadId: HARD_KILL_THREAD_ID,
    turnId: HARD_KILL_TURN_ID,
    createdAt: "2026-07-13T00:00:00.155Z",
    payload: { taskId: RuntimeTaskId.make("buffering-barrier"), taskType: "analysis" },
  });
  yield* harness.waitForThread(HARD_KILL_THREAD_ID, (thread) =>
    thread.activities.some(
      (activity) => activity.id === "evt-coalescing-hard-kill-buffering-barrier",
    ),
  );
  const bufferedParentThread =
    yield* harness.snapshotQuery.getThreadDetailById(HARD_KILL_THREAD_ID);
  if (
    Option.isNone(bufferedParentThread) ||
    bufferedParentThread.value.messages.some(
      (message) => message.id === `assistant:${PARENT_ITEM_ID}`,
    )
  ) {
    return yield* Effect.die(
      "Expected journal-backed assistant text to remain buffered before a durable boundary.",
    );
  }
  yield* adapter.emitRuntimeEvent(hardKillParentPauseEvent());
  yield* harness.waitForThread(HARD_KILL_THREAD_ID, (thread) =>
    thread.messages.some(
      (message) =>
        message.id === `assistant:${PARENT_ITEM_ID}` &&
        !message.streaming &&
        message.text === "parent durable prefix ",
    ),
  );
  yield* adapter.emitRuntimeEvent({
    type: "content.delta",
    eventId: EventId.make("evt-coalescing-hard-kill-large-prefix"),
    provider: PROVIDER,
    threadId: HARD_KILL_THREAD_ID,
    itemId: LARGE_ITEM_ID,
    createdAt: "2026-07-13T00:00:00.180Z",
    payload: { streamKind: "assistant_text", delta: LARGE_PREFIX },
  });
  yield* harness.waitForThread(HARD_KILL_THREAD_ID, (thread) =>
    thread.messages.some(
      (message) =>
        message.id === `assistant:${LARGE_ITEM_ID}` &&
        message.streaming &&
        message.text === LARGE_PREFIX,
    ),
  );
  const accepted = yield* adapter.acceptRuntimeEventWithoutDelivery(
    hardKillDeltaEvent({
      eventId: "evt-coalescing-hard-kill-suffix",
      createdAt: "2026-07-13T00:00:00.100Z",
      delta: "accepted suffix",
    }),
  );
  if (!accepted) {
    return yield* Effect.die("Expected the suffix to be newly accepted into the durable journal.");
  }
  const parentAccepted = yield* adapter.acceptRuntimeEventWithoutDelivery(
    hardKillParentDeltaEvent({
      eventId: "evt-coalescing-hard-kill-parent-suffix",
      createdAt: "2026-07-13T00:00:00.170Z",
      // Deliberately byte-identical to the completed pre-approval segment.
      // Recovery must use event ordering, never text equality, to distinguish it.
      delta: "parent durable prefix ",
    }),
  );
  if (!parentAccepted) {
    return yield* Effect.die("Expected parent assistant bytes to enter the durable journal.");
  }
  const largeSuffixAccepted = yield* adapter.acceptRuntimeEventWithoutDelivery({
    type: "content.delta",
    eventId: EventId.make("evt-coalescing-hard-kill-large-suffix"),
    provider: PROVIDER,
    threadId: HARD_KILL_THREAD_ID,
    itemId: LARGE_ITEM_ID,
    createdAt: "2026-07-13T00:00:00.190Z",
    payload: { streamKind: "assistant_text", delta: "large accepted suffix" },
  });
  if (!largeSuffixAccepted) {
    return yield* Effect.die("Expected the large-message suffix to enter the durable journal.");
  }

  // The marker is deliberately emitted after journal commit but before the
  // adapter's volatile queue offer. SIGKILL here exercises the earliest
  // accepted boundary shared by the current provider adapters.
  process.stdout.write(`${HARD_KILL_READY_MARKER}\n`);
  return yield* Effect.never;
});

Effect.runPromise(run.pipe(Effect.scoped, Effect.provide(NodeServices.layer))).catch(
  (cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  },
);
