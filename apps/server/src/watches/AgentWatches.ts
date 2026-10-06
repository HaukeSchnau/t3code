import {
  CommandId,
  IsoDateTime,
  MessageId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2Notification,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  makeWatchChangeGate,
  makeWatchFloodGate,
  makeWatchShutdownGuard,
  runWatchCommand,
  type WatchCommandOutcome,
  type WatchLines,
} from "./WatchRuntime.ts";

export const WatchId = TrimmedNonEmptyString.pipe(Schema.brand("WatchId"));
export type WatchId = typeof WatchId.Type;

export const WatchSourceInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread"),
    threadId: ThreadId,
    runId: Schema.optional(RunId),
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    command: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
    cwd: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type WatchSourceInput = typeof WatchSourceInput.Type;

const WatchSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread"),
    threadId: ThreadId,
    /** Null until the watched thread's first run exists. */
    runId: Schema.NullOr(RunId),
  }),
  Schema.Struct({ type: Schema.Literal("command"), command: Schema.String, cwd: Schema.String }),
]);
type WatchSource = typeof WatchSource.Type;

const WatchCloseReason = Schema.Literals([
  "fired",
  "exited",
  "failed",
  "cancelled",
  "deadline",
  "watcher_closed",
]);

export const AgentWatch = Schema.Struct({
  watchId: WatchId,
  label: Schema.NullOr(Schema.String),
  source: WatchSource,
  state: Schema.Literals(["open", "closed"]),
  closeReason: Schema.NullOr(WatchCloseReason),
  deadlineAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type AgentWatch = typeof AgentWatch.Type;

/** A wake-up for the watching thread. Its key makes the dispatch ids, so redelivery is a no-op. */
const WatchDelivery = Schema.Struct({
  key: Schema.String,
  text: Schema.String,
  notification: OrchestrationV2Notification,
});
type WatchDelivery = typeof WatchDelivery.Type;

const WatchRow = Schema.Struct({
  watch_id: WatchId,
  watcher_thread_id: ThreadId,
  label: Schema.NullOr(Schema.String),
  source_json: Schema.fromJsonString(WatchSource),
  // `closing` holds a final wake-up that a restart must still deliver.
  state: Schema.Literals(["open", "closing", "closed"]),
  close_reason: Schema.NullOr(WatchCloseReason),
  final_json: Schema.NullOr(Schema.fromJsonString(WatchDelivery)),
  deadline_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
});
const decodeRow = Schema.decodeUnknownEffect(WatchRow);
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(WatchSource));
const encodeDelivery = Schema.encodeEffect(Schema.fromJsonString(WatchDelivery));

type Watch = typeof WatchRow.Type;

type Decision =
  | { readonly reason: "cancelled" | "deadline" | "watcher_closed" }
  | { readonly reason: "fired" | "exited" | "failed"; readonly delivery: WatchDelivery };

export class AgentWatchNotFoundError extends Schema.TaggedError<AgentWatchNotFoundError>()(
  "AgentWatchNotFoundError",
  { resource: Schema.Literals(["watch", "thread", "run"]), id: Schema.String },
) {
  override get message(): string {
    return `The ${this.resource} ${this.id} was not found.`;
  }
}

export class AgentWatchInputError extends Schema.TaggedError<AgentWatchInputError>()(
  "AgentWatchInputError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class AgentWatchDeniedError extends Schema.TaggedError<AgentWatchDeniedError>()(
  "AgentWatchDeniedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class AgentWatchUnavailableError extends Schema.TaggedError<AgentWatchUnavailableError>()(
  "AgentWatchUnavailableError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

export class AgentWatches extends Context.Service<
  AgentWatches,
  {
    readonly create: (input: {
      readonly watcherThreadId: ThreadId;
      readonly source: WatchSourceInput;
      readonly label?: string | undefined;
      readonly deadline?: string | undefined;
    }) => Effect.Effect<
      AgentWatch,
      | AgentWatchNotFoundError
      | AgentWatchInputError
      | AgentWatchDeniedError
      | AgentWatchUnavailableError
    >;
    /** The thread's watches, newest first. */
    readonly list: (input: {
      readonly watcherThreadId: ThreadId;
      readonly includeClosed: boolean;
    }) => Effect.Effect<ReadonlyArray<AgentWatch>, AgentWatchUnavailableError>;
    readonly cancel: (input: {
      readonly watcherThreadId: ThreadId;
      readonly watchId: WatchId;
    }) => Effect.Effect<AgentWatch, AgentWatchNotFoundError | AgentWatchUnavailableError>;
    /** Resumes stored watches and closes watches whose thread is archived or deleted. */
    readonly start: Effect.Effect<void>;
  }
>()("t3/watches/AgentWatches") {}

const LIST_LIMIT = 100;
const TARGET_EVENTS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "run.created",
  "run.updated",
  "thread.deleted",
]);
const DURATION_PATTERN = /^\d+(?:\.\d+)? (?:millis|seconds?|minutes?|hours?|days?|weeks?)$/;

function isDurationInput(value: string): value is `${number} ${Duration.Unit}` {
  return DURATION_PATTERN.test(value);
}

function firstLine(value: string, max = 80): string {
  const line = value.trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function watchName(watch: Watch): string {
  if (watch.label !== null) return watch.label;
  return watch.source_json.type === "command"
    ? firstLine(watch.source_json.command)
    : watch.source_json.threadId;
}

function monitor(
  outcome: OrchestrationV2Notification["outcome"],
  summary: string,
  detail?: string,
): OrchestrationV2Notification {
  return { source: { kind: "monitor" }, outcome, summary, ...(detail ? { detail } : {}) };
}

const RUN_ENDINGS = {
  completed: ["completed", "completed"],
  failed: ["failed", "failed"],
  interrupted: ["cancelled", "was interrupted"],
  cancelled: ["cancelled", "was cancelled"],
  rolled_back: ["cancelled", "was rolled back"],
} as const;

function threadFired(
  watch: Watch,
  threadId: ThreadId,
  title: string,
  run: OrchestrationV2Run | null,
): Decision {
  const name = title.trim().length > 0 ? `"${firstLine(title)}"` : threadId;
  const [outcome, verb] =
    run !== null && ThreadManagementService.isTerminalRunStatus(run.status)
      ? RUN_ENDINGS[run.status]
      : (["unknown", "was deleted"] as const);
  const prefix = watch.label === null ? "" : `${watch.label}: `;
  return {
    reason: "fired",
    delivery: {
      key: "fired",
      text: [
        `Watch ${watch.watch_id}${watch.label === null ? "" : ` (${watch.label})`} fired: thread ${name} (${threadId})${run === null ? "" : ` run ${run.id}`} ${verb}.`,
        ...(run === null ? [] : ["Read its result with t3_thread_read."]),
      ].join("\n"),
      notification: monitor(outcome, `${prefix}Thread ${name} ${verb}`),
    },
  };
}

function commandOutput(
  watch: Watch,
  generation: number,
  sequence: number,
  lines: WatchLines,
): WatchDelivery {
  const output = lines.join("\n");
  return {
    key: `${generation}:${sequence}`,
    text: `Watch ${watch.watch_id} (${watchName(watch)}) reported new output:\n${output}`,
    notification: monitor("updated", `Watch "${watchName(watch)}" reported new output`, output),
  };
}

function commandClosed(
  watch: Watch,
  generation: number,
  outcome: WatchCommandOutcome | { readonly type: "overloaded" },
): Decision {
  const name = watchName(watch);
  const close = (
    reason: "exited" | "failed",
    status: "completed" | "failed",
    summary: string,
    explanation: string,
  ): Decision => ({
    reason,
    delivery: {
      key: `${generation}:exit`,
      text: `Watch ${watch.watch_id} (${name}) closed: ${explanation}`,
      notification: monitor(status, summary),
    },
  });
  switch (outcome.type) {
    case "exited":
      return outcome.exitCode === 0
        ? close(
            "exited",
            "completed",
            `Watch "${name}" finished`,
            "the command exited with code 0.",
          )
        : close(
            "exited",
            "failed",
            `Watch "${name}" failed (exit ${outcome.exitCode})`,
            `the command exited with code ${outcome.exitCode}.`,
          );
    case "overloaded":
      return close(
        "failed",
        "failed",
        `Watch "${name}" stopped: too much output`,
        "the command printed faster than the watch delivers for 30 seconds. Print only lines worth waking for.",
      );
    case "failed":
    case "stopped":
      return close(
        "failed",
        "failed",
        `Watch "${name}" failed`,
        outcome.type === "failed" ? outcome.detail : "the command stopped.",
      );
  }
}

function toView(watch: Watch): AgentWatch {
  return {
    watchId: watch.watch_id,
    label: watch.label,
    source: watch.source_json,
    state: watch.state === "open" ? "open" : "closed",
    closeReason: watch.close_reason,
    deadlineAt: watch.deadline_at,
    createdAt: watch.created_at,
    closedAt: watch.closed_at,
  };
}

function isLive(thread: OrchestrationV2ThreadShell | null): boolean {
  return thread !== null && thread.deletedAt === null && thread.archivedAt === null;
}

const unavailable = (operation: string) => (cause: unknown) =>
  new AgentWatchUnavailableError({ operation, cause });

const logUnlessInterrupted =
  (message: string, annotations: Record<string, unknown>) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...annotations, cause });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const scope = yield* Effect.scope;
  const fibers = yield* FiberMap.make<WatchId>();
  const runFork = yield* FiberMap.runtime(fibers)<never>();
  const shutdown = yield* makeWatchShutdownGuard();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const decodeRows = (rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeRow(row).pipe(
        Effect.asSome,
        Effect.catchCause((cause) =>
          Effect.logWarning("Skipping an unreadable watch", { cause }).pipe(
            Effect.as(Option.none()),
          ),
        ),
      ),
    ).pipe(Effect.map((watches) => watches.flatMap(Option.toArray)));

  const loadWatch = (watchId: WatchId) =>
    sql`SELECT * FROM agent_watches WHERE watch_id = ${watchId}`.pipe(
      Effect.flatMap((rows) => decodeRows(rows)),
      Effect.map((watches) => watches[0] ?? null),
      Effect.mapError(unavailable("read the watch")),
    );

  const readThread = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable("read the thread")));

  // A failed read must not cancel a watch, so it counts as live.
  const watcherIsLive = (watch: Watch) =>
    readThread(watch.watcher_thread_id).pipe(
      Effect.map(isLive),
      Effect.orElseSucceed(() => true),
    );

  /** Delivers unless the watching thread is gone. Stable ids make repeats a no-op. */
  const deliver = (watch: Watch, delivery: WatchDelivery) =>
    Effect.gen(function* () {
      if (!(yield* watcherIsLive(watch))) return false;
      const id = `${watch.watch_id}:${delivery.key}`;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${id}:command`),
          threadId: watch.watcher_thread_id,
          messageId: MessageId.make(id),
          text: delivery.text,
          attachments: [],
          notification: delivery.notification,
          // The orchestrator accepts notifications only as queued dispatches.
          // This starts an idle thread and waits behind an active turn.
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not deliver a watch notification", {
              watchId: watch.watch_id,
              cause,
            }),
          ),
        );
      return true;
    });

  const closeRow = (watchId: WatchId, reason: "cancelled" | "deadline" | "watcher_closed") =>
    nowIso.pipe(
      Effect.flatMap(
        (closedAt) => sql`
          UPDATE agent_watches
          SET state = 'closed', close_reason = ${reason}, closed_at = ${closedAt}
          WHERE watch_id = ${watchId} AND state = 'open'
        `,
      ),
      Effect.mapError(unavailable("close the watch")),
    );

  const deliverFinal = (watch: Watch, delivery: WatchDelivery) =>
    deliver(watch, delivery).pipe(
      Effect.andThen(
        sql`
          UPDATE agent_watches SET state = 'closed', final_json = NULL
          WHERE watch_id = ${watch.watch_id} AND state = 'closing'
        `,
      ),
      Effect.mapError(unavailable("close the watch")),
    );

  // Uninterruptible so cancellation and shutdown never leave a half-closed row.
  const finish = (watch: Watch, decision: Decision) =>
    Effect.gen(function* () {
      if (!("delivery" in decision)) {
        yield* closeRow(watch.watch_id, decision.reason);
        return;
      }
      const finalJson = yield* encodeDelivery(decision.delivery).pipe(
        Effect.mapError(unavailable("store the watch result")),
      );
      const closedAt = yield* nowIso;
      const claimed = yield* sql`
        UPDATE agent_watches
        SET state = 'closing', close_reason = ${decision.reason},
            final_json = ${finalJson}, closed_at = ${closedAt}
        WHERE watch_id = ${watch.watch_id} AND state = 'open'
        RETURNING watch_id
      `.pipe(Effect.mapError(unavailable("close the watch")));
      if (claimed.length > 0) yield* deliverFinal(watch, decision.delivery);
    }).pipe(
      Effect.catchCause(
        logUnlessInterrupted("Could not close a watch", { watchId: watch.watch_id }),
      ),
      Effect.uninterruptible,
    );

  const evaluateTarget = (watch: Watch, source: Extract<WatchSource, { type: "thread" }>) =>
    Effect.gen(function* () {
      const target = yield* readThread(source.threadId);
      if (target === null || target.deletedAt !== null) {
        return Option.some(threadFired(watch, source.threadId, target?.title ?? "", null));
      }
      const { runs } = yield* threads
        .getThreadRecords(
          source.threadId,
          ["runs"],
          source.runId === null ? undefined : { runIds: [source.runId] },
        )
        .pipe(Effect.mapError(unavailable("read the watched thread")));
      const run =
        source.runId === null
          ? runs.toSorted((left, right) => left.ordinal - right.ordinal)[0]
          : runs.find((candidate) => candidate.id === source.runId);
      return run !== undefined && ThreadManagementService.isTerminalRunStatus(run.status)
        ? Option.some(threadFired(watch, source.threadId, target.title, run))
        : Option.none<Decision>();
    });

  const deadlineAt = (watch: Watch) =>
    watch.deadline_at === null ? Option.none() : DateTime.make(watch.deadline_at);

  const waitForDeadline = (watch: Watch): Effect.Effect<Decision> =>
    Option.match(deadlineAt(watch), {
      onNone: () => Effect.never,
      onSome: (deadline) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.sleep(Duration.millis(Math.max(0, DateTime.toEpochMillis(deadline) - now))),
          ),
          Effect.as({ reason: "deadline" } as const),
        ),
    });

  const followTarget = (
    watch: Watch,
    source: Extract<WatchSource, { type: "thread" }>,
  ): Effect.Effect<Decision> =>
    Effect.gen(function* () {
      // Read the cursor before the state so no run update falls between them.
      const afterSequence = yield* threads
        .getThreadEventSequence(source.threadId)
        .pipe(Effect.mapError(unavailable("follow the watched thread")));
      const current = yield* evaluateTarget(watch, source);
      if (Option.isSome(current)) return current.value;
      const fired = yield* threads
        .streamStoredEventsFrom({ threadId: source.threadId, afterSequence })
        .pipe(
          Stream.mapError(unavailable("follow the watched thread")),
          Stream.filter((stored) => TARGET_EVENTS.has(stored.event.type)),
          Stream.mapEffect(() => evaluateTarget(watch, source)),
          Stream.filter(Option.isSome),
          Stream.map((decision) => decision.value),
          Stream.runHead,
        );
      return Option.isSome(fired)
        ? fired.value
        : yield* new AgentWatchUnavailableError({
            operation: "follow the watched thread",
            cause: "The thread event stream ended.",
          });
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Watch lost its thread subscription", {
          watchId: watch.watch_id,
          error,
        }),
      ),
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.orDie,
    );

  const followCommand = (
    watch: Watch,
    source: Extract<WatchSource, { type: "command" }>,
  ): Effect.Effect<Decision> =>
    Effect.gen(function* () {
      // Each spawn gets a new generation so its wake-ups never reuse an earlier id.
      const [row] = yield* sql<{ readonly generation: number }>`
        UPDATE agent_watches SET generation = generation + 1
        WHERE watch_id = ${watch.watch_id}
        RETURNING generation
      `.pipe(Effect.orDie);
      const generation = row?.generation ?? 0;
      const pace = makeWatchFloodGate();
      const changed = makeWatchChangeGate();
      let sequence = 0;
      let stop: Decision | undefined;
      const onBatch = (lines: WatchLines) =>
        Effect.gen(function* () {
          const pacing = pace(yield* Clock.currentTimeMillis);
          if (pacing === "drop") return true;
          if (pacing === "overloaded") {
            stop = commandClosed(watch, generation, { type: "overloaded" });
            return false;
          }
          if (!changed(lines)) return true;
          sequence += 1;
          if (yield* deliver(watch, commandOutput(watch, generation, sequence, lines))) {
            return true;
          }
          stop = { reason: "watcher_closed" };
          return false;
        });
      const outcome = yield* runWatchCommand(
        { command: source.command, cwd: source.cwd, platform },
        onBatch,
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      return stop ?? commandClosed(watch, generation, outcome);
    });

  const runWatch = (watch: Watch) =>
    Effect.gen(function* () {
      const source = watch.source_json;
      const decision = yield* Effect.raceAllFirst([
        waitForDeadline(watch),
        source.type === "thread" ? followTarget(watch, source) : followCommand(watch, source),
      ]);
      const close = finish(watch, decision);
      // A service manager may kill the command on its way down; that exit
      // must leave the watch open for the next start.
      yield* source.type === "command" && "delivery" in decision
        ? shutdown.unlessStopping(close)
        : close;
    }).pipe(
      Effect.catchCause(logUnlessInterrupted("A watch stopped", { watchId: watch.watch_id })),
    );

  const decideNow = (watch: Watch) =>
    Effect.gen(function* () {
      if (!(yield* watcherIsLive(watch))) {
        return Option.some<Decision>({ reason: "watcher_closed" });
      }
      const now = yield* Clock.currentTimeMillis;
      if (Option.exists(deadlineAt(watch), (deadline) => DateTime.toEpochMillis(deadline) <= now)) {
        return Option.some<Decision>({ reason: "deadline" });
      }
      return watch.source_json.type === "thread"
        ? yield* evaluateTarget(watch, watch.source_json).pipe(
            Effect.orElseSucceed(() => Option.none<Decision>()),
          )
        : Option.none<Decision>();
    });

  /** Settles what is already decided, then follows the rest in the background. */
  const attach = (watch: Watch) =>
    Effect.gen(function* () {
      if (watch.state === "closing") {
        if (watch.final_json !== null) {
          yield* deliverFinal(watch, watch.final_json).pipe(Effect.uninterruptible);
        }
        return;
      }
      if (watch.state === "closed") return;
      const decided = yield* decideNow(watch);
      if (Option.isSome(decided)) {
        yield* finish(watch, decided.value);
        return;
      }
      yield* Effect.sync(() => runFork(watch.watch_id, runWatch(watch), { onlyIfMissing: true }));
    });

  const resolveThreadSource = (
    watcher: OrchestrationV2ThreadShell,
    input: Extract<WatchSourceInput, { type: "thread" }>,
  ) =>
    Effect.gen(function* () {
      if (input.threadId === watcher.id) {
        return yield* new AgentWatchInputError({ detail: "A thread cannot watch itself." });
      }
      const target = yield* readThread(input.threadId);
      if (target === null || target.deletedAt !== null) {
        return yield* new AgentWatchNotFoundError({ resource: "thread", id: input.threadId });
      }
      const records = yield* threads
        .getThreadRecords(
          input.threadId,
          ["runs"],
          input.runId === undefined ? undefined : { runIds: [input.runId] },
        )
        .pipe(Effect.mapError(unavailable("read the watched thread")));
      if (input.runId !== undefined) {
        if (!records.runs.some((run) => run.id === input.runId)) {
          return yield* new AgentWatchNotFoundError({ resource: "run", id: input.runId });
        }
        return { type: "thread", threadId: input.threadId, runId: input.runId } as const;
      }
      const queued = records.runs.filter((run) => run.status === "queued");
      const next =
        ThreadManagementService.latestActiveRun(records) ??
        (queued.length === 0
          ? undefined
          : queuedRunsInDeliveryOrder({
              runs: records.runs,
              messages: (yield* threads
                .getThreadRecords(input.threadId, ["messages"], {
                  messageIds: queued.map((run) => run.userMessageId),
                })
                .pipe(Effect.mapError(unavailable("read the watched thread")))).messages,
            })[0]) ??
        // An idle thread that already ran fires at once, which covers a run
        // that finished before the watch arrived.
        ThreadManagementService.latestRun(records);
      return { type: "thread", threadId: input.threadId, runId: next?.id ?? null } as const;
    });

  const resolveCommandSource = (
    watcher: OrchestrationV2ThreadShell,
    input: Extract<WatchSourceInput, { type: "command" }>,
  ) =>
    Effect.gen(function* () {
      if (watcher.runtimeMode !== "full-access") {
        return yield* new AgentWatchDeniedError({
          detail: "Command watches run without approval, so they need a full-access thread.",
        });
      }
      const root =
        watcher.worktreePath ??
        Option.getOrNull(
          Option.map(
            yield* projects
              .get(watcher.projectId)
              .pipe(Effect.mapError(unavailable("read the project"))),
            (project) => project.workspaceRoot,
          ),
        );
      if (root === null) {
        return yield* new AgentWatchInputError({
          detail: "This thread has no workspace to run the command in.",
        });
      }
      return {
        type: "command",
        command: input.command,
        cwd: input.cwd === undefined ? root : path.resolve(root, input.cwd),
      } as const;
    });

  const parseDeadline = (input: string, now: DateTime.Utc) => {
    const value = input.trim();
    const deadline = isDurationInput(value)
      ? Option.some(DateTime.addDuration(now, value))
      : /^\d{4}-\d{2}-\d{2}T/.test(value)
        ? DateTime.make(value)
        : Option.none();
    return Option.match(deadline, {
      onNone: () =>
        Effect.fail(
          new AgentWatchInputError({
            detail: 'deadline must be an ISO date-time or a duration such as "30 minutes".',
          }),
        ),
      onSome: (at) => Effect.succeed(DateTime.formatIso(DateTime.toUtc(at))),
    });
  };

  const view = (watchId: WatchId) =>
    loadWatch(watchId).pipe(
      Effect.flatMap((watch) =>
        watch === null
          ? Effect.fail(new AgentWatchNotFoundError({ resource: "watch", id: watchId }))
          : Effect.succeed(toView(watch)),
      ),
    );

  const create: AgentWatches["Service"]["create"] = Effect.fn("AgentWatches.create")(
    function* (input) {
      const watcher = yield* readThread(input.watcherThreadId);
      if (watcher === null || !isLive(watcher)) {
        return yield* new AgentWatchNotFoundError({
          resource: "thread",
          id: input.watcherThreadId,
        });
      }
      const now = yield* DateTime.now;
      const deadline =
        input.deadline === undefined ? null : yield* parseDeadline(input.deadline, now);
      const source =
        input.source.type === "thread"
          ? yield* resolveThreadSource(watcher, input.source)
          : yield* resolveCommandSource(watcher, input.source);
      const sourceJson = yield* encodeSource(source).pipe(
        Effect.mapError(unavailable("store the watch")),
      );
      const watch: Watch = {
        watch_id: WatchId.make(`watch:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
        watcher_thread_id: watcher.id,
        label: input.label?.trim() || null,
        source_json: source,
        state: "open",
        close_reason: null,
        final_json: null,
        deadline_at: deadline,
        created_at: DateTime.formatIso(now),
        closed_at: null,
      };
      yield* sql`
        INSERT INTO agent_watches ${sql.insert({ ...watch, source_json: sourceJson })}
      `.pipe(Effect.mapError(unavailable("store the watch")));
      yield* attach(watch);
      return yield* view(watch.watch_id);
    },
  );

  const list: AgentWatches["Service"]["list"] = Effect.fn("AgentWatches.list")(function* (input) {
    const rows = yield* (
      input.includeClosed
        ? sql`
            SELECT * FROM agent_watches WHERE watcher_thread_id = ${input.watcherThreadId}
            ORDER BY created_at DESC, watch_id LIMIT ${LIST_LIMIT}
          `
        : sql`
            SELECT * FROM agent_watches
            WHERE watcher_thread_id = ${input.watcherThreadId} AND state = 'open'
            ORDER BY created_at DESC, watch_id LIMIT ${LIST_LIMIT}
          `
    ).pipe(Effect.mapError(unavailable("list watches")));
    return (yield* decodeRows(rows)).map(toView);
  });

  const stopWatch = (watchId: WatchId, reason: "cancelled" | "watcher_closed") =>
    FiberMap.remove(fibers, watchId).pipe(Effect.andThen(closeRow(watchId, reason)));

  const cancel: AgentWatches["Service"]["cancel"] = Effect.fn("AgentWatches.cancel")(
    function* (input) {
      const watch = yield* loadWatch(input.watchId);
      if (watch === null || watch.watcher_thread_id !== input.watcherThreadId) {
        return yield* new AgentWatchNotFoundError({ resource: "watch", id: input.watchId });
      }
      yield* stopWatch(watch.watch_id, "cancelled");
      return yield* view(watch.watch_id);
    },
  );

  const closeWatchesOf = (threadId: ThreadId) =>
    sql<{ readonly watch_id: WatchId }>`
      SELECT watch_id FROM agent_watches
      WHERE watcher_thread_id = ${threadId} AND state = 'open'
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => stopWatch(row.watch_id, "watcher_closed"), {
          discard: true,
        }),
      ),
      Effect.catchCause(logUnlessInterrupted("Could not close watches", { threadId })),
    );

  const start: AgentWatches["Service"]["start"] = Effect.gen(function* () {
    yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
      event.type === "thread.archived" || event.type === "thread.deleted"
        ? closeWatchesOf(event.threadId)
        : Effect.void,
    ).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Watch lifecycle subscription failed", { error }),
      ),
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    const rows = yield* sql`SELECT * FROM agent_watches WHERE state <> 'closed'`;
    yield* Effect.forEach(
      yield* decodeRows(rows),
      (watch) =>
        attach(watch).pipe(
          Effect.catchCause(
            logUnlessInterrupted("Could not resume a watch", { watchId: watch.watch_id }),
          ),
        ),
      { discard: true },
    );
  }).pipe(Effect.catchCause(logUnlessInterrupted("Could not resume watches", {})));

  return AgentWatches.of({ create, list, cancel, start });
});

/** Resumes stored watches once the server is activated. */
export const layer = Layer.effect(
  AgentWatches,
  make.pipe(Effect.tap((watches) => forkParked(watches.start))),
);
