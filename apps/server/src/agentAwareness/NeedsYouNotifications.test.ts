import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  GuestMessageId,
  GuestShareId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  type ThreadAsk,
  ThreadAskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  applyToProjection,
  emptyProjection,
  type ProjectionRecordFilter,
  threadShellFromProjection,
} from "../orchestration-v2/ProjectionStore.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as LocalAgentAwareness from "./LocalAgentAwareness.ts";
import * as NeedsYouLedger from "./NeedsYouLedger.ts";
import * as NeedsYouNotifications from "./NeedsYouNotifications.ts";
import { needsYouThreads, shellNeed } from "./needsYouRules.ts";

const environmentId = EnvironmentId.make("environment");
const instanceId = ProviderInstanceId.make("codex");
// Local wall-clock times: reminders and the digest follow the server's time zone.
// @effect-diagnostics-next-line globalDate:off - A time in the test process's own time zone.
const local = (hour: number, minute = 0) => new Date(2026, 10, 19, hour, minute).getTime();
const utc = (millis: number) => DateTime.makeUnsafe(millis);
const iso = (millis: number) => DateTime.formatIso(utc(millis));

function appThread(
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project"),
    title: `Thread ${id}`,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: utc(local(9)),
    updatedAt: utc(local(9)),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

type Outcome = NeedsYouLedger.NeedsYouDeliveryOutcome;
type EventInput = OrchestrationV2DomainEvent extends infer E
  ? E extends OrchestrationV2DomainEvent
    ? Omit<E, "id" | "occurredAt">
    : never
  : never;

/**
 * The orchestrator as the needs-you service sees it: committed events in order, and the
 * projections and shells they build. Watches live outside the events, as `t3_watch` does.
 */
const makeWorld = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<OrchestrationV2StoredEvent>({ replay: 100_000 });
  return {
    events,
    projections: new Map<ThreadId, OrchestrationV2ThreadProjection>(),
    watches: new Map<ThreadId, ReadonlyArray<OrchestrationV2PendingBackgroundTask>>(),
    returned: [] as Array<string>,
    sequence: 0,
  };
});
type World = Effect.Success<typeof makeWorld>;

const shellOf = (world: World, threadId: ThreadId): OrchestrationV2ThreadShell | null => {
  const projection = world.projections.get(threadId);
  if (projection === undefined) return null;
  const shell = threadShellFromProjection(projection);
  const watches = world.watches.get(threadId) ?? [];
  return watches.length === 0
    ? shell
    : { ...shell, pendingBackgroundTasks: [...(shell.pendingBackgroundTasks ?? []), ...watches] };
};

const emit = (world: World, input: EventInput) =>
  Effect.gen(function* () {
    world.sequence += 1;
    const event = {
      ...input,
      id: EventId.make(`event:${world.sequence}`),
      occurredAt: yield* DateTime.now,
    } as OrchestrationV2DomainEvent;
    const projection = world.projections.get(event.threadId);
    world.projections.set(
      event.threadId,
      projection === undefined
        ? emptyProjection(event as Extract<typeof event, { type: "thread.created" }>)
        : applyToProjection(projection, event),
    );
    yield* PubSub.publish(world.events, { sequence: world.sequence, commandId: null, event });
  });

const threadsOf = (world: World) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.sync(() => shellOf(world, threadId)),
    getThreadRecords: ((
      threadId: ThreadId,
      _fields: unknown,
      filter: ProjectionRecordFilter = {},
    ) =>
      Effect.sync(() => {
        const projection = world.projections.get(threadId)!;
        const has = <A>(values: ReadonlyArray<A> | undefined, value: A) =>
          values === undefined || values.includes(value);
        return {
          thread: projection.thread,
          runs: projection.runs.filter((run) => has(filter.runIds, run.id)),
          messages: projection.messages.filter(
            (message) =>
              has(filter.messageRunIds, message.runId) && has(filter.messageRoles, message.role),
          ),
          turnItems: projection.turnItems.filter(
            (item) =>
              has(filter.turnItemRunIds, item.runId) &&
              has(filter.turnItemTypes, item.type) &&
              has(filter.turnItemStatuses, item.status),
          ),
          runtimeRequests: projection.runtimeRequests.filter((request) =>
            has(filter.runtimeRequestStatuses, request.status),
          ),
        };
      })) as never,
    getShellSnapshot: () =>
      Effect.sync(
        () =>
          ({
            snapshotSequence: world.sequence,
            threads: [...world.projections.keys()].map((threadId) => shellOf(world, threadId)!),
          }) as never,
      ),
    dispatch: (command) =>
      Effect.sync(() => {
        if (command.type === "thread.return") world.returned.push(command.runId);
        return { sequence: 0, storedEvents: [] };
      }),
    streamDomainEventsAfter: (after) =>
      Stream.fromPubSub(world.events).pipe(Stream.filter((stored) => stored.sequence > after)),
  });

/**
 * One server process: start it on the shared database, then emit events and read its pushes.
 * Leaving the scope stops it, like a deploy. `deliver` answers for APNs (default: accepted).
 */
const makeServer = (
  world: World,
  options: {
    readonly tokens?: ReadonlyArray<string>;
    readonly deliver?: (
      token: string,
      push: LocalAgentAwareness.NeedsYouPush,
    ) => Effect.Effect<Outcome> | Outcome;
    readonly threads?: Layer.Layer<ThreadManagement.ThreadManagementService>;
    readonly ledger?: (
      ledger: NeedsYouLedger.NeedsYouLedger["Service"],
    ) => NeedsYouLedger.NeedsYouLedger["Service"];
    readonly awaitStart?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const tokens = options.tokens ?? ["phone"];
    const pushes: Array<string> = [];
    // Counts and accepted alerts in the order they happened.
    const log: Array<string> = [];
    const services = Layer.mergeAll(
      Layer.mock(LocalAgentAwareness.LocalAgentAwareness)({
        setNeedsYouCount: (count) => Effect.sync(() => void log.push(`count ${count}`)),
        alertTargets: () => Effect.succeed(tokens),
        deliverAlert: <E>({ token, prepare }: LocalAgentAwareness.AlertDelivery<E>) =>
          prepare.pipe(
            Effect.flatMap((prepared) => {
              if (prepared === null) return Effect.succeed("cancelled" as const);
              const { push, silent } = prepared;
              return Effect.suspend(() => {
                const answer = options.deliver?.(token, push) ?? "accepted";
                return typeof answer === "string" ? Effect.succeed(answer) : answer;
              }).pipe(
                Effect.tap((outcome) =>
                  Effect.sync(() => {
                    if (outcome !== "accepted") return;
                    const device = tokens.length > 1 ? `${token} ` : "";
                    const line = `${device}${push.title}: ${push.body}${silent ? " (silent)" : ""}`;
                    pushes.push(line);
                    log.push(line);
                  }),
                ),
              );
            }),
          ),
      }),
      options.threads ?? threadsOf(world),
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedSome({ title: "T3 Code" } as never),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      // Each process has its own ledger service on the shared database.
      options.ledger === undefined
        ? NeedsYouLedger.layer
        : Layer.effect(
            NeedsYouLedger.NeedsYouLedger,
            Effect.map(Effect.service(NeedsYouLedger.NeedsYouLedger), options.ledger),
          ).pipe(Layer.provide(NeedsYouLedger.layer)),
    );
    const { notifications, ledger } = yield* Effect.gen(function* () {
      return {
        notifications: yield* NeedsYouNotifications.make,
        ledger: yield* NeedsYouLedger.NeedsYouLedger,
      };
    }).pipe(Effect.provide(services));
    yield* notifications.start;
    if (options.awaitStart !== false) yield* notifications.settle(world.sequence);
    const settle = Effect.suspend(() => notifications.settle(world.sequence));
    return {
      pushes,
      log,
      notifications,
      ledger,
      settle,
      /** Waits until what was emitted is recorded, not delivered. */
      recorded: Effect.suspend(() => notifications.recorded(world.sequence)),
      emit: (input: EventInput) => emit(world, input).pipe(Effect.andThen(settle)),
      minutes: (count: number) => TestClock.adjust(`${count} minutes`).pipe(Effect.andThen(settle)),
      subjects: notifications.subjects.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((snapshots) => [...snapshots][0]!.subjects),
      ),
    };
  });

/** A fresh database per test; servers started inside share it across restarts. */
const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  runMigrations().pipe(
    Effect.andThen(effect),
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

/** Events that build threads and runs. */
const world = {
  thread: (id: string, overrides: Partial<OrchestrationV2AppThread> = {}) =>
    ({
      type: "thread.created",
      threadId: ThreadId.make(id),
      payload: appThread(id, overrides),
    }) as const,
  /** A message that starts a run: the user's, or a wake's when `by` is "agent". */
  message: (thread: string, run: string, by: "user" | "agent" = "user") =>
    Effect.map(DateTime.now, (now) => ({
      type: "message.updated" as const,
      threadId: ThreadId.make(thread),
      payload: {
        createdBy: by,
        creationSource: by === "user" ? ("web" as const) : ("mcp" as const),
        id: MessageId.make(`message:${run}`),
        threadId: ThreadId.make(thread),
        runId: RunId.make(run),
        nodeId: null,
        role: "user" as const,
        text: by === "user" ? "Do the thing." : "Wake up.",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    })),
  run: (
    thread: string,
    id: string,
    status: OrchestrationV2Run["status"],
    ordinal = 1,
    type: "run.created" | "run.updated" = status === "running" || status === "queued"
      ? "run.created"
      : "run.updated",
  ) =>
    Effect.map(DateTime.now, (now) => ({
      type,
      threadId: ThreadId.make(thread),
      payload: {
        id: RunId.make(id),
        threadId: ThreadId.make(thread),
        ordinal,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${id}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: status === "completed" || status === "failed" ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      } satisfies OrchestrationV2Run,
    })),
  request: (
    thread: string,
    id: string,
    status: "pending" | "resolved" = "pending",
    kind: "user_input" | "command" = "user_input",
  ) =>
    Effect.map(DateTime.now, (now) => ({
      type: "runtime-request.updated" as const,
      threadId: ThreadId.make(thread),
      payload: {
        id: RuntimeRequestId.make(id),
        nodeId: NodeId.make(`node:${thread}`),
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("session"),
        },
        createdAt: now,
        resolvedAt: status === "pending" ? null : now,
      },
    })),
  /** A secret card the agent waits on in its run. */
  secret: (thread: string, id: string, run: string) =>
    Effect.map(DateTime.now, (now) => ({
      type: "turn-item.updated" as const,
      threadId: ThreadId.make(thread),
      payload: {
        id: TurnItemId.make(id),
        type: "secret_request" as const,
        threadId: ThreadId.make(thread),
        runId: RunId.make(run),
        nodeId: NodeId.make(`node:${thread}`),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        label: "Deploy token",
        reason: "Read the logs",
        secretStatus: "pending" as const,
      },
    })),
};

/** The thread with its asks: the turn-end ask of `run` raised now, or ended. */
const asks = (
  w: World,
  thread: string,
  entries: ReadonlyArray<Partial<ThreadAsk> & { readonly run: string }>,
) =>
  Effect.map(DateTime.now, (now) => {
    const current = w.projections.get(ThreadId.make(thread))!.thread;
    return {
      type: "thread.asks-updated" as const,
      threadId: ThreadId.make(thread),
      payload: {
        ...current,
        asks: entries.map(({ run, ...ask }) => ({
          id: ThreadAskId.make(`turn_end:${run}`),
          source: { type: "turn_end" as const, runId: RunId.make(run) },
          text: `Pick ${run}?`,
          raisedAt: DateTime.formatIso(now),
          status: "open" as const,
          ...ask,
        })),
      },
    };
  });

/** A user's message starts a run that then ends. */
const userRunEnds = (
  server: { readonly emit: (input: EventInput) => Effect.Effect<void> },
  thread: string,
  run: string,
  status: "completed" | "failed" = "completed",
) =>
  Effect.gen(function* () {
    yield* server.emit(yield* world.message(thread, run));
    yield* server.emit(yield* world.run(thread, run, "running"));
    yield* server.emit(yield* world.run(thread, run, status));
  });

const watch: OrchestrationV2PendingBackgroundTask = {
  taskId: "watch:deploy",
  kind: "monitor",
  awaited: true,
};

describe("needs-you rules", () => {
  it("counts only listed threads, by the clients' rule", () => {
    const shell = (overrides: Partial<OrchestrationV2AppThread>) =>
      threadShellFromProjection(
        emptyProjection({
          id: EventId.make("event"),
          type: "thread.created",
          threadId: ThreadId.make("t"),
          occurredAt: utc(local(17)),
          payload: appThread("t", overrides),
        }),
      );
    const open = {
      asks: [
        {
          id: ThreadAskId.make("turn_end:a"),
          source: { type: "turn_end" as const, runId: RunId.make("a") },
          text: "Pick a?",
          raisedAt: iso(local(17)),
          status: "open" as const,
        },
      ],
    };
    assert.equal(shellNeed(shell(open))?.text, "Pick a?");
    assert.equal(shellNeed({ ...shell({}), pendingGuestMessageCount: 1 })?.text, "Guest message");
    for (const hidden of [
      { archivedAt: utc(local(17)) },
      {
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent" as const,
        },
      },
    ]) {
      assert.equal(shellNeed(shell({ ...open, ...hidden })), null);
      assert.deepEqual(needsYouThreads([shell({ ...open, ...hidden })], local(17)), []);
    }
  });

  it("follows every event that can change a need or free a held completion", () => {
    const event = (type: string, payload: object = {}) =>
      ({ type, threadId: ThreadId.make("t"), payload }) as unknown as OrchestrationV2DomainEvent;
    for (const changes of [
      event("thread.snoozed"),
      event("thread.guest-share-updated"),
      event("runtime-request.updated"),
      event("run.updated"),
      // Background work ends: these free a completion it held.
      event("provider-thread.updated"),
      event("run.background-work-cancelled"),
      event("subagent.updated"),
      event("turn-item.updated", { type: "command_execution", status: "completed" }),
      event("turn-item.updated", { type: "secret_request", status: "running" }),
    ]) {
      assert.isTrue(NeedsYouNotifications.changesNeeds(changes), changes.type);
    }
    for (const quiet of [
      event("message.updated"),
      event("turn-item.updated", { type: "agent_message", status: "running" }),
    ]) {
      assert.isFalse(NeedsYouNotifications.changesNeeds(quiet), quiet.type);
    }
  });
});

describe("NeedsYouNotifications", () => {
  it.effect("an ask replaces its run's Done quietly, and No reply needed sends nothing", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w);
            yield* userRunEnds(server, "t", "r");
            yield* server.emit(yield* asks(w, "t", [{ run: "r" }]));
            yield* server.emit(yield* asks(w, "t", [{ run: "r", status: "dismissed" }]));
            assert.deepEqual(server.pushes, [
              "Thread t: Done: T3 Code",
              "Thread t: Pick r? (silent)",
            ]);
            assert.deepEqual(w.returned, ["r"]);
            // Clients read the same subjects, with the ask's end. The ask took the Done's place
            // for good, so a client catching up after No reply needed presents neither.
            const subjects = yield* server.subjects;
            assert.deepEqual(
              subjects.map(({ id, replaces, resolved, superseded }) => ({
                id,
                replaces,
                resolved,
                superseded,
              })),
              [
                { id: "run:r", replaces: undefined, resolved: false, superseded: true },
                { id: "ask:turn_end:r", replaces: "run:r", resolved: true, superseded: false },
              ],
            );
          }),
        );
      }),
    ),
  );

  it.effect(
    "a run the user started alerts and returns its thread even when a wake runs right after it; the wake stays quiet",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("done"));
          yield* emit(w, world.thread("failed"));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              for (const [thread, status] of [
                ["done", "completed"],
                ["failed", "failed"],
              ] as const) {
                yield* server.emit(yield* world.message(thread, `${thread}-user`));
                yield* server.emit(yield* world.run(thread, `${thread}-user`, "running"));
                if (thread === "failed") {
                  // Snoozed while its run worked: the failure wakes it, also with a wake running.
                  const now = yield* DateTime.now;
                  yield* server.emit({
                    type: "thread.snoozed",
                    threadId: ThreadId.make(thread),
                    payload: {
                      ...w.projections.get(ThreadId.make(thread))!.thread,
                      snoozedAt: now,
                      snoozedUntil: DateTime.add(now, { hours: 2 }),
                    },
                  });
                  yield* TestClock.adjust("1 second");
                }
                // A wake queued behind the user's run starts the moment it ends.
                yield* server.emit(yield* world.message(thread, `${thread}-wake`, "agent"));
                yield* server.emit(yield* world.run(thread, `${thread}-wake`, "queued", 2));
                yield* emit(w, yield* world.run(thread, `${thread}-user`, status));
                yield* emit(
                  w,
                  yield* world.run(thread, `${thread}-wake`, "running", 2, "run.updated"),
                );
                yield* server.settle;
                yield* server.emit(yield* world.run(thread, `${thread}-wake`, "completed", 2));
              }
              assert.deepEqual(server.pushes, [
                "Thread done: Done: T3 Code",
                "Thread failed: Failed: T3 Code",
              ]);
              assert.deepEqual(w.returned, ["done-user", "failed-user"]);
            }),
          );
        }),
      ),
  );

  it.effect(
    "a run that runs again under its id after it failed alerts, returns and is read at each end",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              const sql = yield* SqlClient.SqlClient;
              yield* userRunEnds(server, "t", "r", "failed");
              // A failure is not read for an ask.
              assert.deepEqual(yield* sql`SELECT run_id FROM needs_you_checks`, []);
              // Its workspace preparation failed; the retry runs under the same id and succeeds.
              yield* TestClock.adjust("1 minute");
              yield* server.emit(yield* world.run("t", "r", "running", 1, "run.updated"));
              const end = yield* world.run("t", "r", "completed");
              yield* server.emit(end);
              // A repeated update of the same end reads nothing again.
              yield* server.emit(end);
              assert.deepEqual(server.pushes, [
                "Thread t: Failed: T3 Code",
                "Thread t: Done: T3 Code",
              ]);
              assert.deepEqual(w.returned, ["r", "r"]);
              assert.deepEqual(yield* sql`SELECT run_id, ended_at FROM needs_you_checks`, [
                { run_id: "r", ended_at: iso(local(17, 1)) },
              ]);
            }),
          );
        }),
      ),
  );

  it.effect(
    "checks each delivery right before it goes out: a device still waiting for Done gets only the ask, with a sound",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          const ipadSending = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w, {
                tokens: ["ipad", "phone"],
                deliver: (token, push) =>
                  token === "ipad" && push.body.startsWith("Done")
                    ? Deferred.succeed(ipadSending, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.as("accepted" as const),
                      )
                    : "accepted",
              });
              yield* server.emit(yield* world.message("t", "r"));
              yield* server.emit(yield* world.run("t", "r", "running"));
              yield* emit(w, yield* world.run("t", "r", "completed"));
              // The iPad's Done is on its way when the run's ask arrives.
              yield* Deferred.await(ipadSending);
              yield* emit(w, yield* asks(w, "t", [{ run: "r" }]));
              yield* server.recorded;
              yield* Deferred.succeed(release, undefined);
              yield* server.settle;
              assert.deepEqual(server.pushes, [
                "ipad Thread t: Done: T3 Code",
                "ipad Thread t: Pick r? (silent)",
                "phone Thread t: Pick r?",
              ]);
            }),
          );
        }),
      ),
  );

  it.effect(
    "a completion held by background work stays replaced by its ask, also after No reply needed",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              w.watches.set(ThreadId.make("t"), [watch]);
              yield* userRunEnds(server, "t", "r");
              // The user dismisses the ask at once, before anything decides the held completion.
              yield* emit(w, yield* asks(w, "t", [{ run: "r" }]));
              yield* emit(w, yield* asks(w, "t", [{ run: "r", status: "dismissed" }]));
              yield* server.settle;
              w.watches.delete(ThreadId.make("t"));
              yield* server.minutes(1);
              assert.notInclude(server.pushes, "Thread t: Done: T3 Code");
              assert.notInclude(
                (yield* server.subjects).map((subject) => subject.id),
                "run:r",
              );
            }),
          );
        }),
      ),
  );

  it.effect(
    "a page ask the run set covers its Done, also once dismissed before the run ended; a withdrawn one does not, and a failure always alerts",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          const runs = [
            ["dismissed", "completed"],
            ["withdrawn", "completed"],
            ["failed", "failed"],
          ] as const;
          for (const [thread] of runs) yield* emit(w, world.thread(thread));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              for (const [thread, status] of runs) {
                const run = `${thread}-run`;
                const pageAsk = (askStatus: ThreadAsk["status"]) =>
                  asks(w, thread, [
                    {
                      run,
                      id: ThreadAskId.make(`page:${run}`),
                      source: { type: "page", renderId: "layouts", runId: RunId.make(run) },
                      status: askStatus,
                    },
                  ]);
                yield* server.emit(yield* world.message(thread, run));
                yield* server.emit(yield* world.run(thread, run, "running"));
                yield* server.emit(yield* pageAsk("open"));
                if (thread !== "failed") yield* server.emit(yield* pageAsk(thread));
                yield* server.emit(yield* world.run(thread, run, status));
              }
              assert.deepEqual(server.pushes, [
                "Thread dismissed: Pick dismissed-run?",
                "Thread withdrawn: Pick withdrawn-run?",
                "Thread withdrawn: Done: T3 Code",
                "Thread failed: Pick failed-run?",
                "Thread failed: Failed: T3 Code",
              ]);
            }),
          );
        }),
      ),
  );

  it.effect(
    "a completion held past the alert window alerts once a watch closes without a thread event",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              w.watches.set(ThreadId.make("t"), [watch]);
              yield* userRunEnds(server, "t", "r");
              yield* server.minutes(11);
              assert.deepEqual(server.pushes, []);
              w.watches.delete(ThreadId.make("t"));
              yield* server.minutes(1);
              assert.deepEqual(server.pushes, ["Thread t: Done: T3 Code"]);
            }),
          );
        }),
      ),
  );

  it.effect.each(["after the restart", "during the outage"] as const)(
    "a completion held through an outage longer than the alert window alerts once the hold ends %s",
    (ends) =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          w.watches.set(ThreadId.make("t"), [watch]);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* userRunEnds(server, "t", "r");
            }),
          );
          yield* TestClock.adjust("15 minutes");
          if (ends === "during the outage") w.watches.delete(ThreadId.make("t"));
          const pushes = yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              if (ends === "after the restart") {
                yield* server.minutes(1);
                assert.deepEqual(server.pushes, []);
                w.watches.delete(ThreadId.make("t"));
              }
              yield* server.minutes(1);
              return server.pushes;
            }),
          );
          assert.deepEqual(pushes, ["Thread t: Done: T3 Code"]);
        }),
      ),
  );

  it.effect(
    "alerts every pending request on its own: two in one thread, and a subagent's approval on its parent",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          yield* emit(
            w,
            world.thread("child", {
              lineage: {
                rootThreadId: ThreadId.make("t"),
                parentThreadId: ThreadId.make("t"),
                relationshipToParent: "subagent",
              },
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* server.emit(yield* world.request("t", "q1"));
              yield* server.emit(yield* world.request("t", "q2"));
              yield* server.emit(yield* world.message("child", "child-run", "agent"));
              yield* server.emit(yield* world.run("child", "child-run", "running"));
              yield* server.emit(yield* world.request("child", "approve", "pending", "command"));
              // Its own question only reaches its coordinator.
              yield* server.emit(yield* world.request("child", "question"));
              assert.deepEqual(server.pushes, [
                "Thread t: Input: T3 Code",
                "Thread t: Input: T3 Code",
                "Thread t: Approval: T3 Code",
              ]);
              // One thread waits, however many of its requests.
              assert.equal(
                server.log.filter((line) => line.startsWith("count ")).at(-1),
                "count 1",
              );
            }),
          );
        }),
      ),
  );

  it.effect("a delivery that failed is not tried again once the user answered elsewhere", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        const attempts: Array<string> = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w, {
              deliver: (_token, push) => {
                attempts.push(push.collapseKey);
                return "failed";
              },
            });
            yield* server.emit(yield* world.request("t", "q"));
            yield* server.emit(yield* world.request("t", "q", "resolved"));
            yield* server.minutes(2);
            assert.deepEqual(attempts, ["request:q"]);
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(yield* sql`SELECT status FROM needs_you_deliveries`, [
              { status: "cancelled" },
            ]);
            // The run that asked for a secret ended, so nobody waits for it, though the card has
            // not closed yet.
            yield* server.emit(yield* world.message("t", "r", "agent"));
            yield* server.emit(yield* world.run("t", "r", "running"));
            yield* server.emit(yield* world.secret("t", "secret", "r"));
            yield* server.emit(yield* world.run("t", "r", "completed"));
            yield* server.minutes(1);
            assert.deepEqual(attempts, ["request:q", "request:secret"]);
            // Guest message a is sent before the service reads that it was; b still waits.
            const guestShare = (aStatus: "pending" | "sent") => ({
              ...w.projections.get(ThreadId.make("t"))!.thread,
              guestShare: {
                id: GuestShareId.make("share"),
                host: "t3.example",
                createdAt: iso(local(17)),
                expiresAt: iso(local(41)),
                guestName: "Ana",
                messages: [
                  { id: GuestMessageId.make("a"), text: "Ship it?", status: aStatus },
                  { id: GuestMessageId.make("b"), text: "And docs?", status: "pending" as const },
                ].map((message) => ({ ...message, submittedAt: iso(local(17, 2)) })),
              },
            });
            yield* server.emit({
              type: "thread.guest-share-updated",
              threadId: ThreadId.make("t"),
              payload: guestShare("pending"),
            });
            const projection = w.projections.get(ThreadId.make("t"))!;
            w.projections.set(ThreadId.make("t"), { ...projection, thread: guestShare("sent") });
            yield* server.minutes(1);
            assert.deepEqual(attempts.slice(2), ["guest:a", "guest:b", "guest:b"]);
          }),
        );
      }),
    ),
  );

  it.effect("start retries until it can seed its cursor, and alerts after that", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        let failures = 1;
        const live = threadsOf(w);
        const flaky = Layer.effect(
          ThreadManagement.ThreadManagementService,
          Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            return ThreadManagement.ThreadManagementService.of({
              ...threads,
              getShellSnapshot: (options) =>
                failures-- > 0
                  ? Effect.fail(
                      new OrchestratorProjectionError({
                        threadId: ThreadId.make("t"),
                        cause: "database busy",
                      }),
                    )
                  : threads.getShellSnapshot(options),
            });
          }),
        ).pipe(Layer.provide(live));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w, { threads: flaky, awaitStart: false });
            yield* TestClock.adjust("1 second");
            yield* server.settle;
            yield* server.emit(yield* world.request("t", "q"));
            assert.deepEqual(server.pushes, ["Thread t: Input: T3 Code"]);
          }),
        );
      }),
    ),
  );

  it.effect(
    "reads again from the cursor after a failed batch or stream, and sends a failed thread return again",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          yield* emit(w, world.thread("other"));
          let streamFailures = 1;
          let returnFailures = 1;
          const flaky = Layer.effect(
            ThreadManagement.ThreadManagementService,
            Effect.gen(function* () {
              const threads = yield* ThreadManagement.ThreadManagementService;
              const unavailable = new OrchestratorProjectionError({
                threadId: ThreadId.make("t"),
                cause: "database busy",
              });
              return ThreadManagement.ThreadManagementService.of({
                ...threads,
                streamDomainEventsAfter: (after) =>
                  streamFailures-- > 0
                    ? Stream.fail(unavailable)
                    : threads.streamDomainEventsAfter(after),
                dispatch: (command) =>
                  command.type === "thread.return" && returnFailures-- > 0
                    ? Effect.fail(unavailable)
                    : threads.dispatch(command),
              });
            }),
          ).pipe(Layer.provide(threadsOf(w)));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w, { threads: flaky });
              // The stream failed at once; the run ends while nothing reads.
              yield* emit(w, yield* world.message("t", "r"));
              yield* emit(w, yield* world.run("t", "r", "running"));
              yield* emit(w, yield* world.run("t", "r", "completed"));
              yield* emit(w, yield* world.request("other", "q"));
              yield* server.minutes(1);
              assert.deepEqual(server.pushes, [
                "Thread t: Done: T3 Code",
                "Thread other: Input: T3 Code",
              ]);
              assert.deepEqual(w.returned, ["r"]);
            }),
          );
        }),
      ),
  );

  it.effect("a deploy sends nothing for what was already there, then alerts what is new", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        yield* emit(w, world.thread("done"));
        yield* emit(w, yield* world.message("done", "old"));
        yield* emit(w, yield* world.run("done", "old", "running"));
        const oldEnd = yield* world.run("done", "old", "completed");
        yield* emit(w, oldEnd);
        yield* emit(w, yield* asks(w, "t", [{ run: "old" }]));
        const oldRequest = yield* world.request("t", "q");
        yield* emit(w, oldRequest);
        yield* TestClock.adjust("1 minute");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w);
            // Live updates repeat a run's end, an open ask and a pending request from before.
            yield* server.emit(oldEnd);
            const thread = w.projections.get(ThreadId.make("t"))!.thread;
            yield* server.emit({ type: "thread.visited", threadId: thread.id, payload: thread });
            yield* server.emit(oldRequest);
            yield* server.emit(yield* world.request("t", "q2"));
            assert.deepEqual(server.pushes, ["Thread t: Input: T3 Code"]);
          }),
        );
      }),
    ),
  );

  it.effect("a restart between recording an alert and sending it sends it once", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        const sending = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* makeServer(w, {
              // The process stops while APNs has the request.
              deliver: () =>
                Deferred.succeed(sending, undefined).pipe(Effect.andThen(Effect.never)),
            });
            yield* emit(w, yield* world.request("t", "q"));
            yield* Deferred.await(sending);
          }),
        );
        const next = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w);
            yield* server.minutes(1);
            return server.pushes;
          }),
        );
        assert.deepEqual(next, ["Thread t: Input: T3 Code"]);
      }),
    ),
  );

  it.effect(
    "a restart before the cursor moved reads the events again and records nothing twice",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* userRunEnds(server, "t", "r");
              yield* server.emit(yield* world.request("t", "q"));
              return server.pushes;
            }),
          );
          assert.deepEqual(first, ["Thread t: Done: T3 Code", "Thread t: Input: T3 Code"]);
          // The process stopped after recording but before its cursor reached these events.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE needs_you_cursor SET sequence = 1`;
          const again = yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* server.minutes(1);
              return server.pushes;
            }),
          );
          assert.deepEqual(again, []);
          // The command id makes the second return a no-op.
          assert.deepEqual(w.returned, ["r", "r"]);
        }),
      ),
  );

  it.effect(
    "reminds each need once an hour in, after a restart past the hour, a snooze or a wake",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(10));
          const w = yield* makeWorld;
          for (const id of ["asked", "snoozed", "woken", "late"]) {
            yield* emit(w, world.thread(id));
          }
          const snooze = (id: string, overrides: Partial<OrchestrationV2AppThread>) =>
            ({
              type: "thread.snoozed",
              threadId: ThreadId.make(id),
              payload: { ...w.projections.get(ThreadId.make(id))!.thread, ...overrides },
            }) as const;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* server.emit(yield* asks(w, "asked", [{ run: "a" }]));
              yield* server.emit(yield* world.request("snoozed", "q"));
              yield* server.emit(yield* world.request("woken", "q2"));
              yield* server.emit(yield* world.request("late", "q3"));
              yield* server.emit(
                snooze("snoozed", { snoozedAt: utc(local(10)), snoozedUntil: utc(local(12)) }),
              );
              // Woken by hand at 11:00, so it reminds an hour after the wake, not at once.
              yield* server.emit(
                snooze("woken", {
                  snoozedAt: null,
                  snoozedUntil: null,
                  lastSnoozeWakeAt: utc(local(11)),
                }),
              );
            }),
          );
          // The server was down past the hour: the ask reminds once it is back.
          yield* TestClock.setTime(local(11, 30));
          const reminders = yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              // Snoozed right as its reminder comes due, before the service reads the event.
              const late = w.projections.get(ThreadId.make("late"))!;
              w.projections.set(ThreadId.make("late"), {
                ...late,
                thread: {
                  ...late.thread,
                  snoozedAt: utc(local(11, 30)),
                  snoozedUntil: utc(local(12, 30)),
                },
              });
              yield* server.minutes(1);
              const back = [...server.pushes];
              yield* server.minutes(88);
              const beforeSnoozeEnds = [...server.pushes];
              yield* server.minutes(2);
              yield* server.minutes(60);
              return { back, beforeSnoozeEnds, after: server.pushes };
            }),
          );
          assert.deepEqual(reminders.back, ["Thread asked: Still waiting: Pick a?"]);
          assert.deepEqual(reminders.beforeSnoozeEnds, [
            "Thread asked: Still waiting: Pick a?",
            "Thread woken: Still waiting: Question",
          ]);
          assert.deepEqual(reminders.after, [
            ...reminders.beforeSnoozeEnds,
            "Thread snoozed: Still waiting: Question",
            "Thread late: Still waiting: Question",
          ]);
        }),
      ),
  );

  it.effect(
    "an ask whose queued answer the user cancelled reminds an hour after it opened again",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(17));
          const w = yield* makeWorld;
          for (const id of ["t", "u", "v"]) yield* emit(w, world.thread(id));
          const raisedAt = iso(local(17));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* server.emit(yield* asks(w, "t", [{ run: "r", raisedAt }]));
              yield* server.emit(yield* asks(w, "u", [{ run: "s", raisedAt }]));
              yield* TestClock.adjust("5 minutes");
              yield* server.emit(yield* asks(w, "t", [{ run: "r", raisedAt, status: "answered" }]));
              yield* TestClock.adjust("5 minutes");
              yield* server.emit(yield* asks(w, "t", [{ run: "r", raisedAt }]));
              assert.deepEqual(server.pushes, ["Thread t: Pick r?", "Thread u: Pick s?"]);
            }),
          );
          // While the server is down, "v" raises an ask at 17:10, and its answer and cancellation
          // come at 17:11. In "u" the answer and its cancellation come at 17:12. The next start
          // reads each in one batch.
          const raisedWhileDown = iso(local(17, 10));
          yield* emit(w, yield* asks(w, "v", [{ run: "x", raisedAt: raisedWhileDown }]));
          yield* TestClock.adjust("1 minute");
          yield* emit(
            w,
            yield* asks(w, "v", [{ run: "x", raisedAt: raisedWhileDown, status: "answered" }]),
          );
          yield* emit(w, yield* asks(w, "v", [{ run: "x", raisedAt: raisedWhileDown }]));
          yield* TestClock.adjust("1 minute");
          yield* emit(w, yield* asks(w, "u", [{ run: "s", raisedAt, status: "answered" }]));
          yield* emit(w, yield* asks(w, "u", [{ run: "s", raisedAt }]));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* server.minutes(57);
              const alerted = ["Thread v: Pick x?"];
              assert.deepEqual(server.pushes, alerted);
              yield* server.minutes(1);
              assert.deepEqual(server.pushes, [...alerted, "Thread t: Still waiting: Pick r?"]);
              yield* server.minutes(1);
              assert.deepEqual(server.pushes, [
                ...alerted,
                "Thread t: Still waiting: Pick r?",
                "Thread v: Still waiting: Pick x?",
              ]);
              yield* server.minutes(1);
              assert.deepEqual(server.pushes, [
                ...alerted,
                "Thread t: Still waiting: Pick r?",
                "Thread v: Still waiting: Pick x?",
                "Thread u: Still waiting: Pick s?",
              ]);
            }),
          );
        }),
      ),
  );

  it.effect(
    "reminds a need snoozed past the 30-day pruning an hour after the snooze ends, and one that reminded never again",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* TestClock.setTime(local(10));
          const w = yield* makeWorld;
          yield* emit(w, world.thread("t"));
          yield* emit(w, world.thread("u"));
          const day = 24 * 60 * 60_000;
          const snooze = (id: string) =>
            Effect.map(DateTime.now, (now) => ({
              type: "thread.snoozed" as const,
              threadId: ThreadId.make(id),
              payload: {
                ...w.projections.get(ThreadId.make(id))!.thread,
                snoozedAt: now,
                snoozedUntil: utc(local(9) + 45 * day),
              },
            }));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* server.emit(yield* world.request("t", "q"));
              yield* server.emit(yield* snooze("t"));
              // "u" reminds once before it is snoozed too.
              yield* server.emit(yield* world.request("u", "q2"));
              yield* server.minutes(61);
              assert.deepEqual(server.pushes.slice(-1), ["Thread u: Still waiting: Question"]);
              yield* server.emit(yield* snooze("u"));
            }),
          );
          // Past the 30 days after which the start prunes the ledger.
          yield* TestClock.setTime(local(10) + 45 * day);
          const pushes = yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* makeServer(w);
              yield* server.minutes(1);
              return server.pushes;
            }),
          );
          assert.deepEqual(pushes, ["Thread t: Still waiting: Question"]);
        }),
      ),
  );

  it.effect("sends the digest at 19:00 once, naming the thread waiting longest", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(18, 50));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("old"));
        yield* emit(w, world.thread("new"));
        const pushes = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w);
            yield* server.emit(yield* world.request("old", "q1"));
            yield* TestClock.adjust("1 minute");
            yield* server.emit(yield* world.request("new", "q2"));
            yield* server.minutes(10);
            yield* server.minutes(30);
            return server.pushes;
          }),
        );
        assert.deepEqual(pushes.slice(2), ["2 threads need you: Waiting longest: Thread old"]);
      }),
    ),
  );

  it.effect("the count goes out before the alerts that carry it, and never waits on APNs", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("a"));
        yield* emit(w, world.thread("b"));
        const sending = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w, {
              deliver: (_token, push) =>
                push.title === "Thread a"
                  ? Deferred.succeed(sending, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as("accepted" as const),
                    )
                  : "accepted",
            });
            yield* emit(w, yield* world.request("a", "q1"));
            yield* Deferred.await(sending);
            // APNs hangs on the first alert; the next event is still recorded and counted.
            yield* emit(w, yield* world.request("b", "q2"));
            yield* server.recorded;
            assert.deepEqual(server.log.slice(-2), ["count 1", "count 2"]);
            yield* Deferred.succeed(release, undefined);
            yield* server.settle;
            assert.deepEqual(server.log.slice(-4), [
              "count 1",
              "count 2",
              "Thread a: Input: T3 Code",
              "Thread b: Input: T3 Code",
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("visiting, archiving and unarchiving a thread alerts nothing again", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w);
            yield* server.emit(yield* asks(w, "t", [{ run: "r" }]));
            const before = yield* server.subjects;
            // A visit's payload is its read state, not the thread.
            yield* server.emit({
              type: "thread.visit-recorded",
              threadId: ThreadId.make("t"),
              payload: { lastVisitedAt: utc(local(17)) },
            });
            const thread = w.projections.get(ThreadId.make("t"))!.thread;
            yield* server.emit({
              type: "thread.archived",
              threadId: thread.id,
              payload: { ...thread, archivedAt: utc(local(17)) },
            });
            yield* server.emit({ type: "thread.unarchived", threadId: thread.id, payload: thread });
            yield* server.minutes(1);
            assert.deepEqual(server.pushes, ["Thread t: Pick r?"]);
            assert.deepEqual(yield* server.subjects, before);
          }),
        );
      }),
    ),
  );

  it.effect("settling a thread ends its open ask for clients", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w);
            yield* server.emit(yield* asks(w, "t", [{ run: "r" }]));
            // Settling dismisses the ask in the thread it settles, with no asks event.
            const dismissed = (yield* asks(w, "t", [{ run: "r", status: "dismissed" }])).payload;
            yield* server.emit({
              type: "thread.settled",
              threadId: ThreadId.make("t"),
              payload: { ...dismissed, settledOverride: "settled", settledAt: yield* DateTime.now },
            });
            assert.deepEqual(
              (yield* server.subjects).map(({ id, resolved }) => ({ id, resolved })),
              [{ id: "ask:turn_end:r", resolved: true }],
            );
          }),
        );
      }),
    ),
  );

  it.effect("a failed read of the subjects is retried, never sent to clients as none", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        let failures = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w, {
              ledger: (ledger) => ({
                ...ledger,
                recent: (since) =>
                  failures-- > 0
                    ? Effect.fail(
                        new SqlError.SqlError({
                          reason: new SqlError.LockTimeoutError({ cause: null }),
                        }),
                      )
                    : ledger.recent(since),
              }),
            });
            yield* server.emit(yield* world.request("t", "q"));
            failures = 1;
            const first = yield* Effect.forkChild(server.subjects);
            yield* TestClock.adjust("1 second");
            assert.deepEqual(
              (yield* Fiber.join(first)).map((subject) => subject.id),
              ["request:q"],
            );
          }),
        );
      }),
    ),
  );

  it.effect("subject versions keep growing after old subjects are pruned", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* TestClock.setTime(local(17));
        const w = yield* makeWorld;
        yield* emit(w, world.thread("t"));
        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w);
            yield* server.emit(yield* world.request("t", "q"));
            yield* server.emit(yield* world.request("t", "q", "resolved"));
            return yield* server.subjects;
          }),
        );
        // A month later the next start prunes that ended subject; browsers still hold its version.
        yield* TestClock.adjust("31 days");
        const after = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(w);
            yield* server.emit(yield* world.request("t", "q2"));
            return yield* server.subjects;
          }),
        );
        assert.deepEqual(
          before.map(({ id, version }) => ({ id, version })),
          [{ id: "request:q", version: 2 }],
        );
        assert.deepEqual(
          after.map(({ id, version }) => ({ id, version })),
          [{ id: "request:q2", version: 3 }],
        );
      }),
    ),
  );
});
