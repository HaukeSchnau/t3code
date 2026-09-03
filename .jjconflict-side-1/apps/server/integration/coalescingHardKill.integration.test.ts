// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

const HARD_KILL_READY_MARKER = "T3_COALESCING_HARD_KILL_READY";
const PROJECT_ID = ProjectId.make("coalescing-hard-kill-project");
const THREAD_ID = ThreadId.make("coalescing-hard-kill-thread");
const TURN_ID = TurnId.make("coalescing-hard-kill-turn");
const ITEM_ID = RuntimeItemId.make("coalescing-hard-kill-item");
const PARENT_ITEM_ID = RuntimeItemId.make("coalescing-hard-kill-parent-item");
const LARGE_ITEM_ID = RuntimeItemId.make("coalescing-hard-kill-large-item");
const PROVIDER = ProviderDriverKind.make("codex");
const FIXTURE_TIME = "2026-07-13T00:00:00.000Z";
const PREFIX = "durable prefix ";
const SUFFIX = "accepted suffix";
const CONTINUATION = " after restart";
const PARENT_PREFIX = "parent durable prefix ";
const PARENT_SUFFIX = "parent durable prefix ";
const LARGE_PREFIX = "s".repeat(24_001);
const LARGE_SUFFIX = "large accepted suffix";

function deltaEvent(input: {
  readonly eventId: string;
  readonly createdAt: string;
  readonly delta: string;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    eventId: EventId.make(input.eventId),
    provider: PROVIDER,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: ITEM_ID,
    agentContext: {
      providerThreadId: "coalescing-hard-kill-child",
      parentTurnId: TURN_ID,
    },
    createdAt: input.createdAt,
    payload: { streamKind: "assistant_text", delta: input.delta },
  };
}

function terminalEvent(): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    eventId: EventId.make("evt-coalescing-hard-kill-terminal"),
    provider: PROVIDER,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    createdAt: "2026-07-13T00:00:01.000Z",
    payload: { state: "completed" },
  };
}

function parentCompletionEvent(): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    eventId: EventId.make("evt-coalescing-hard-kill-parent-completed"),
    provider: PROVIDER,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: PARENT_ITEM_ID,
    createdAt: "2026-07-13T00:00:00.250Z",
    payload: { itemType: "assistant_message", status: "completed" },
  };
}

function largeCompletionEvent(): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    eventId: EventId.make("evt-coalescing-hard-kill-large-completed"),
    provider: PROVIDER,
    threadId: THREAD_ID,
    itemId: LARGE_ITEM_ID,
    createdAt: "2026-07-13T00:00:00.260Z",
    payload: { itemType: "assistant_message", status: "completed" },
  };
}

function transcriptFromThread(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): string | null {
  const activity = thread.activities.find((candidate) => candidate.kind === "subagent.thread");
  if (activity === undefined || typeof activity.payload !== "object" || activity.payload === null) {
    return null;
  }
  const transcript = (activity.payload as Record<string, unknown>).transcript;
  return typeof transcript === "string" ? transcript : null;
}

function subagentPayload(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): Record<string, unknown> | null {
  const activity = thread.activities.find((candidate) => candidate.kind === "subagent.thread");
  return activity !== undefined && typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function waitForMarker(child: NodeChildProcess.ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for hard-kill marker. stdout=${output} stderr=${errorOutput}`),
      );
    }, 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(HARD_KILL_READY_MARKER)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      if (output.includes(HARD_KILL_READY_MARKER)) return;
      clearTimeout(timeout);
      reject(
        new Error(
          `Hard-kill child exited before readiness: code=${String(code)} signal=${String(signal)} stdout=${output} stderr=${errorOutput}`,
        ),
      );
    });
  });
}

function waitForExit(child: NodeChildProcess.ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    child.once("exit", (_code, signal) => resolve(signal));
  });
}

it.live(
  "recovers every accepted transcript byte after hard process loss without provider replay",
  () =>
    Effect.gen(function* () {
      const initialHarness = yield* makeOrchestrationIntegrationHarness();
      const instanceId = defaultInstanceIdForDriver(PROVIDER);
      const model = DEFAULT_MODEL_BY_PROVIDER[PROVIDER] ?? DEFAULT_MODEL;
      yield* initialHarness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("coalescing-hard-kill-project-create"),
        projectId: PROJECT_ID,
        title: "Coalescing hard-kill fixture",
        workspaceRoot: initialHarness.workspaceDir,
        defaultModelSelection: { instanceId, model },
        createdAt: FIXTURE_TIME,
      });
      yield* initialHarness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("coalescing-hard-kill-thread-create"),
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Coalescing hard-kill fixture",
        modelSelection: { instanceId, model },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: initialHarness.workspaceDir,
        createdAt: FIXTURE_TIME,
      });
      const rootDir = initialHarness.rootDir;
      yield* initialHarness.dispose;

      const childPath = NodeURL.fileURLToPath(
        new URL("./fixtures/coalescingHardKillChild.ts", import.meta.url),
      );
      const child = NodeChildProcess.spawn(process.execPath, [childPath, rootDir], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }),
      );
      yield* Effect.promise(() => waitForMarker(child));
      const exit = waitForExit(child);
      assert.equal(child.kill("SIGKILL"), true);
      assert.equal(yield* Effect.promise(() => exit), "SIGKILL");

      const recoveredHarness = yield* makeOrchestrationIntegrationHarness({ rootDir });
      const afterKill = yield* recoveredHarness.waitForThread(
        THREAD_ID,
        (thread) => transcriptFromThread(thread) === `${PREFIX}${SUFFIX}`,
      );
      assert.equal(transcriptFromThread(afterKill), `${PREFIX}${SUFFIX}`);

      const adapter = recoveredHarness.adapterHarness;
      if (adapter === null) return assert.fail("Expected deterministic provider adapter.");
      yield* adapter.emitRuntimeEvent(parentCompletionEvent());
      const afterParentCompletion = yield* recoveredHarness.waitForThread(THREAD_ID, (thread) =>
        thread.messages.some(
          (message) =>
            message.id === `assistant:${PARENT_ITEM_ID}:segment:1` &&
            !message.streaming &&
            message.text === PARENT_SUFFIX,
        ),
      );
      const recoveredParentPrefix = afterParentCompletion.messages.find(
        (message) => message.id === `assistant:${PARENT_ITEM_ID}`,
      );
      const recoveredParentSuffix = afterParentCompletion.messages.find(
        (message) => message.id === `assistant:${PARENT_ITEM_ID}:segment:1`,
      );
      assert.equal(recoveredParentPrefix?.text, PARENT_PREFIX);
      assert.equal(recoveredParentSuffix?.text, PARENT_SUFFIX);

      yield* adapter.emitRuntimeEvent(largeCompletionEvent());
      const afterLargeCompletion = yield* recoveredHarness.waitForThread(THREAD_ID, (thread) =>
        thread.messages.some(
          (message) =>
            message.id === `assistant:${LARGE_ITEM_ID}` &&
            !message.streaming &&
            message.text === `${LARGE_PREFIX}${LARGE_SUFFIX}`,
        ),
      );
      const recoveredLargeMessage = afterLargeCompletion.messages.find(
        (message) => message.id === `assistant:${LARGE_ITEM_ID}`,
      );
      assert.equal(recoveredLargeMessage?.text, `${LARGE_PREFIX}${LARGE_SUFFIX}`);

      yield* adapter.emitRuntimeEvent(
        deltaEvent({
          eventId: "evt-coalescing-hard-kill-continuation",
          createdAt: "2026-07-13T00:00:00.200Z",
          delta: CONTINUATION,
        }),
      );
      const afterContinuation = yield* recoveredHarness.waitForThread(
        THREAD_ID,
        (thread) => transcriptFromThread(thread) === `${PREFIX}${SUFFIX}${CONTINUATION}`,
      );
      assert.equal(transcriptFromThread(afterContinuation), `${PREFIX}${SUFFIX}${CONTINUATION}`);

      // Exact provider replay after recovery is harmless: durable command
      // receipts suppress the old deltas before they can mutate hydrated item
      // state, so later terminal publication cannot duplicate transcript bytes.
      yield* adapter.emitRuntimeEvent(
        deltaEvent({
          eventId: "evt-coalescing-hard-kill-prefix",
          createdAt: "2026-07-13T00:00:00.000Z",
          delta: PREFIX,
        }),
      );
      yield* adapter.emitRuntimeEvent(
        deltaEvent({
          eventId: "evt-coalescing-hard-kill-suffix",
          createdAt: "2026-07-13T00:00:00.100Z",
          delta: SUFFIX,
        }),
      );
      yield* adapter.emitRuntimeEvent(terminalEvent());

      const afterFullReplay = yield* recoveredHarness.waitForThread(
        THREAD_ID,
        (thread) =>
          transcriptFromThread(thread) === `${PREFIX}${SUFFIX}${CONTINUATION}` &&
          subagentPayload(thread)?.status === "completed" &&
          subagentPayload(thread)?.latestEventId === "evt-coalescing-hard-kill-terminal",
      );
      assert.equal(transcriptFromThread(afterFullReplay), `${PREFIX}${SUFFIX}${CONTINUATION}`);
      yield* recoveredHarness.dispose;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
