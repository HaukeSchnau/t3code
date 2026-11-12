import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  type OrchestrationV2Notification,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ThreadShell,
  type RunId,
} from "@t3tools/contracts";
import { threadWaitCheckIn } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

/** A running turn with nothing open and no update for this long is treated as hung. */
const STALLED_RUN_AFTER_MS = 20 * 60_000;
/** A provider that has not ended the turn this long after T3's Stop is force-stopped. */
const FORCE_STOP_AFTER_MS = 2 * 60_000;

interface DueWaitCheckIn {
  readonly quietSince: DateTime.Utc;
  readonly waits: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}

/** A quiet thread whose waits have run past their check-in time, or null. */
function dueWaitCheckIn(
  thread: OrchestrationV2ThreadShell,
  now: DateTime.Utc,
): DueWaitCheckIn | null {
  const checkIn = threadWaitCheckIn(thread);
  const quietSince = thread.latestRunCompletedAt;
  if (checkIn === null || quietSince == null || DateTime.isGreaterThan(checkIn.at, now)) {
    return null;
  }
  return { quietSince, waits: checkIn.waits };
}

function minutesLabel(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function waitLabel(task: OrchestrationV2PendingBackgroundTask): string {
  const description = task.description?.split("\n")[0]?.trim();
  return description && description.length > 0 ? description : `a ${task.kind}`;
}

function waitCheckInMessage(input: DueWaitCheckIn & { readonly now: DateTime.Utc }): {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  const quietFor = minutesLabel(
    DateTime.toEpochMillis(input.now) - DateTime.toEpochMillis(input.quietSince),
  );
  const lines = input.waits.map((task) => {
    const parts = [
      task.startedAt === undefined ? null : `since ${task.startedAt}`,
      task.expectedBy === undefined ? null : `expected by ${task.expectedBy}`,
    ].filter((part) => part !== null);
    return `- ${waitLabel(task)}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`;
  });
  const [first] = input.waits;
  const more = input.waits.length > 1 ? ` and ${input.waits.length - 1} more` : "";
  return {
    text: [
      `T3 check-in: nothing has woken this thread for ${quietFor}, and it is still waiting on:`,
      ...lines,
      "Check on each one now. If something is stuck or failed, deal with it. If a longer wait is normal, end your turn: T3 checks in again later, less often the longer the wait runs. A t3_watch deadline sets when you expect something to be done.",
    ].join("\n"),
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `Check-in after ${quietFor}: ${first === undefined ? "background work" : waitLabel(first)}${more}`,
    },
  };
}

function quietForMs(input: {
  readonly startedAt: string | null;
  readonly lastItemAt: string | null;
  readonly inFlight: boolean;
  readonly now: DateTime.Utc;
}): number {
  if (input.inFlight) return 0;
  const lastActivityMs = Math.max(
    input.startedAt === null ? 0 : Date.parse(input.startedAt),
    input.lastItemAt === null ? 0 : Date.parse(input.lastItemAt),
  );
  return lastActivityMs > 0 ? DateTime.toEpochMillis(input.now) - lastActivityMs : 0;
}

/**
 * What the watchdog does with a running run: stop it once it is quiet, and force-stop a run that
 * is still going two minutes after anyone asked it to stop, open items or not.
 */
export function stalledRunAction(input: {
  readonly quietMs: number;
  readonly sinceStopMs: number | null;
}): "wait" | "stop" | "force-stop" {
  if (input.sinceStopMs !== null) {
    return input.sinceStopMs >= FORCE_STOP_AFTER_MS ? "force-stop" : "wait";
  }
  return input.quietMs >= STALLED_RUN_AFTER_MS ? "stop" : "wait";
}

const STALLED_RUN_TEXT =
  "Your last turn showed no activity for 20 minutes, so T3 stopped it. Continue where you left off. A command or other action it started may have finished or may still be running, so confirm before you repeat one that changes state. If you were waiting on something, check it now, and make sure something will wake you before you end your turn.";

const logUnlessInterrupted =
  (message: string, annotations: Record<string, unknown>) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...annotations, cause });

export class WaitWatchdog extends Context.Service<
  WaitWatchdog,
  { readonly sweep: Effect.Effect<void> }
>()("t3/watches/WaitWatchdog") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  // In memory: a restart interrupts every running run anyway.
  const forceStopped = new Set<RunId>();

  const checkIn = Effect.fn("WaitWatchdog.checkIn")(
    function* (thread: OrchestrationV2ThreadShell, due: DueWaitCheckIn, now: DateTime.Utc) {
      const key = `${thread.id}:${DateTime.toEpochMillis(due.quietSince)}`;
      const commandId = CommandId.make(`command:wait-check-in:${key}`);
      if (yield* threads.hasReceipt(commandId)) return;
      // A held queue waits for its user to resume it, and a check-in would start ahead of it.
      const held = yield* sql<{ readonly run_id: string }>`
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE thread_id = ${thread.id} AND status = 'queued'
          AND json_extract(payload_json, '$.queueHeld') IS 1
        LIMIT 1
      `;
      if (held.length > 0) return;
      const { text, notification } = waitCheckInMessage({ ...due, now });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId: thread.id,
        messageId: MessageId.make(`message:wait-check-in:${key}`),
        text,
        notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      yield* Effect.logInfo("Checked in on a waiting thread", {
        threadId: thread.id,
        waits: due.waits.map((task) => task.taskId),
      });
    },
    (effect, thread) =>
      effect.pipe(
        Effect.catchCause(
          logUnlessInterrupted("Could not check in on a thread", { threadId: thread.id }),
        ),
      ),
  );

  const recoverIfStalled = Effect.fn("WaitWatchdog.recoverIfStalled")(
    function* (thread: OrchestrationV2ThreadShell, runId: RunId, now: DateTime.Utc) {
      const [activity] = yield* sql<{
        readonly started_at: string | null;
        readonly last_item_at: string | null;
        readonly in_flight: number;
        readonly stop_requested_at: string | null;
      }>`
        SELECT json_extract(r.payload_json, '$.startedAt') AS started_at,
          (
            SELECT MAX(i.updated_at) FROM orchestration_v2_projection_turn_items i
            WHERE i.run_id = r.run_id
          ) AS last_item_at,
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items i
            WHERE i.run_id = r.run_id
              -- Work and streaming text only: some items, such as todo lists, never close.
              AND i.type IN ('command_execution', 'dynamic_tool', 'subagent', 'file_change',
                'file_search', 'web_search', 'compaction', 'reasoning', 'assistant_message')
              AND i.status IN ('pending', 'running', 'waiting')
          ) AS in_flight,
          (
            SELECT MAX(i.updated_at) FROM orchestration_v2_projection_turn_items i
            WHERE i.run_id = r.run_id AND i.type = 'run_interrupt_request'
          ) AS stop_requested_at
        FROM orchestration_v2_projection_runs r
        WHERE r.run_id = ${runId} AND r.status = 'running'
      `;
      if (activity === undefined) return;
      const quietMs = quietForMs({
        startedAt: activity.started_at,
        lastItemAt: activity.last_item_at,
        inFlight: activity.in_flight === 1,
        now,
      });
      // A run someone already stopped gets no notice, so a user's held queue stays first.
      const action = stalledRunAction({
        quietMs,
        sinceStopMs:
          activity.stop_requested_at === null
            ? null
            : DateTime.toEpochMillis(now) - Date.parse(activity.stop_requested_at),
      });
      if (action === "wait") return;
      if (action === "force-stop") {
        // The provider ignored Stop, as a hung one does; only Force stop frees the queue.
        if (forceStopped.has(runId)) return;
        yield* threads.forceStopThread({ threadId: thread.id, runId });
        forceStopped.add(runId);
        yield* Effect.logWarning("Force-stopped a stalled run", { threadId: thread.id, runId });
        return;
      }
      // Queued first, so the notice follows any wake already waiting behind the stalled run.
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:stalled-run:${runId}:notice`),
        threadId: thread.id,
        messageId: MessageId.make(`message:stalled-run:${runId}`),
        text: STALLED_RUN_TEXT,
        notification: {
          source: { kind: "system" },
          outcome: "failed",
          summary: "T3 stopped a turn that showed no activity for 20 minutes",
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      yield* threads.interruptThread({
        projectId: thread.projectId,
        commandId: CommandId.make(`command:stalled-run:${runId}:interrupt`),
        threadId: thread.id,
        runId,
        reason: "No activity for 20 minutes",
      });
      yield* Effect.logWarning("Stopped a stalled run", { threadId: thread.id, runId });
    },
    (effect, thread) =>
      effect.pipe(
        Effect.catchCause(
          logUnlessInterrupted("Could not recover a stalled run", { threadId: thread.id }),
        ),
      ),
  );

  const sweep = Effect.fn("WaitWatchdog.sweep")(
    function* () {
      const now = yield* DateTime.now;
      const { threads: shells } = yield* threads.getShellSnapshot({ unsettledOnly: true });
      yield* Effect.forEach(
        shells,
        (thread) => {
          const due = dueWaitCheckIn(thread, now);
          if (due !== null) return checkIn(thread, due, now);
          return thread.activeRunId !== null &&
            thread.activityRunStatus === "running" &&
            thread.pendingRuntimeRequest === null &&
            !isProviderNativeSubagentThread(thread)
            ? recoverIfStalled(thread, thread.activeRunId, now)
            : Effect.void;
        },
        { discard: true },
      );
    },
    (effect) =>
      effect.pipe(Effect.catchCause(logUnlessInterrupted("Wait watchdog sweep failed", {}))),
  );

  return WaitWatchdog.of({ sweep: sweep() });
});

/** Sweeps once a minute after server activation, so restarts resume from stored state. */
export const layer = Layer.effect(
  WaitWatchdog,
  make.pipe(
    Effect.tap((watchdog) =>
      forkParked(watchdog.sweep.pipe(Effect.repeat(Schedule.spaced("1 minute")))),
    ),
  ),
);
