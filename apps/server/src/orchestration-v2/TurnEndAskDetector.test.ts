import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadAskId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadAskStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlError from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as NeedsYouLedger from "../agentAwareness/NeedsYouLedger.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TurnEndAskDetector from "./TurnEndAskDetector.ts";

const threadId = ThreadId.make("thread:turn-end");
const projectId = ProjectId.make("project:turn-end");
const runId = RunId.make("run:turn-end");
const instanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 12, minute));
const ending = "Should I delete them on those four hosts?";

const message = (
  id: string,
  role: "user" | "assistant",
  minute: number,
  text: string,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => ({
  createdBy: role === "user" ? "user" : "agent",
  creationSource: role === "user" ? "web" : "provider",
  id: MessageId.make(id),
  threadId,
  runId: role === "assistant" ? runId : null,
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdAt: at(minute),
  updatedAt: at(minute),
  ...overrides,
});

const projection = (
  change: (base: OrchestrationV2ThreadProjection) => OrchestrationV2ThreadProjection = (base) =>
    base,
): OrchestrationV2ThreadProjection => {
  const base = ProjectionStore.emptyProjection({
    id: EventId.make("event:created"),
    type: "thread.created",
    threadId,
    occurredAt: at(0),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Leftover skills",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at(0),
      updatedAt: at(0),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  return change({
    ...base,
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make("user-1"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(1),
        startedAt: at(1),
        completedAt: at(10),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      message("user-1", "user", 1, "Find the stale skill entries."),
      message("assistant-1", "assistant", 5, "Looking at the hosts now."),
      message("assistant-2", "assistant", 9, `I found 23 leftover dirs. ${ending}`),
    ],
  });
};

const wakeRunId = RunId.make("run:wake");

/** A wake queued behind the user's run started once it ended and is the latest run now. */
const withWakeQueuedBehind = (base: OrchestrationV2ThreadProjection) => ({
  ...base,
  runs: [
    ...base.runs,
    {
      ...base.runs[0]!,
      id: wakeRunId,
      ordinal: 2,
      userMessageId: MessageId.make("wake-1"),
      status: "running" as const,
      requestedAt: at(4),
      startedAt: at(10),
      completedAt: null,
    },
  ],
  messages: [
    ...base.messages,
    message("wake-1", "user", 4, "A background task finished.", {
      createdBy: "agent",
      creationSource: "mcp",
      runId: wakeRunId,
    }),
  ],
});

function makeHarness(
  state: OrchestrationV2ThreadProjection,
  generated: { readonly waitsOnUser: boolean; readonly ask: string } = {
    waitsOnUser: true,
    ask: "Delete 23 leftover skill dirs on 4 hosts?",
  },
) {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const generateTurnEndAsk = vi.fn<TextGeneration.TextGeneration["Service"]["generateTurnEndAsk"]>(
    () => Effect.succeed(generated),
  );
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(ProjectionStore.threadShellFromProjection(state)),
    getThreadRecords: (_threadId, _fields, filter) =>
      Effect.succeed({
        ...state,
        runs: state.runs.filter(
          (run) =>
            (filter?.runIds?.includes(run.id) ?? true) &&
            (filter?.runStatuses?.includes(run.status) ?? true),
        ),
        messages: state.messages.filter(
          (candidate) =>
            (filter?.messageRoles?.includes(candidate.role) ?? true) &&
            (filter?.messageRunIds === undefined ||
              (candidate.runId !== null && filter.messageRunIds.includes(candidate.runId))),
        ),
        turnItems: state.turnItems.filter(
          (item) =>
            (filter?.turnItemTypes?.includes(item.type) ?? true) &&
            (filter?.turnItemStatuses?.includes(item.status) ?? true) &&
            (filter?.turnItemRunIds?.includes(item.runId) ?? true),
        ),
        runtimeRequests: state.runtimeRequests.filter(
          (request) => filter?.runtimeRequestStatuses?.includes(request.status) ?? true,
        ),
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length, storedEvents: [] };
      }),
  });
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getLatestUserReply: () =>
      Effect.succeed(
        state.messages.findLast(
          (candidate) => candidate.role === "user" && candidate.createdBy === "user",
        ),
      ),
  });
  const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: () =>
      Effect.succeedSome({
        projectId,
        title: "Project",
        hasCustomTitle: false,
        workspaceRoot: "/repo",
        defaultModelSelection: { instanceId, model: "gpt-5.4" },
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        trackedFolders: [],
        createdAt: "2026-11-19T00:00:00.000Z",
        updatedAt: "2026-11-19T00:00:00.000Z",
        pinnedAt: null,
        archivedAt: null,
        deletedAt: null,
      }),
  });
  return {
    layer: Layer.mergeAll(
      threads,
      projections,
      projects,
      ServerSettings.layerTest(),
      Layer.mock(TextGeneration.TextGeneration)({ generateTurnEndAsk }),
      // The real ledger, where the needs-you service records completed runs to read.
      NeedsYouLedger.layer.pipe(
        Layer.provideMerge(
          Layer.effectDiscard(runMigrations()).pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
          ),
        ),
      ),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
    dispatched,
    generateTurnEndAsk,
  };
}

/** The runs whose read is done. */
const checked = Effect.gen(function* () {
  const ledger = yield* NeedsYouLedger.NeedsYouLedger;
  const done: Array<RunId> = [];
  for (const candidate of [runId, wakeRunId]) {
    if (yield* ledger.isChecked(candidate)) done.push(candidate);
  }
  return done;
});

/** The needs-you service records the run's end as a run to read. */
const recordCheck = (minute: number) =>
  Effect.gen(function* () {
    const ledger = yield* NeedsYouLedger.NeedsYouLedger;
    yield* ledger.record({
      subjects: [],
      resolve: [],
      checks: [{ runId, threadId, endedAt: DateTime.toEpochMillis(at(minute)) }],
    });
  });

const raised = {
  type: "thread.ask.raise",
  commandId: `thread-ask:turn-end:${runId}`,
  threadId,
  askId: ThreadAskId.make(`turn_end:${runId}`),
  source: { type: "turn_end", runId },
  text: "Delete 23 leftover skill dirs on 4 hosts?",
} as OrchestrationV2ServerCommand;

const detectOnce = Effect.gen(function* () {
  yield* recordCheck(10);
  const detector = yield* TurnEndAskDetector.make;
  yield* detector.detect(threadId, runId);
  yield* detector.drain;
  // A later update of the completed run repeats its status; it is classified once.
  yield* detector.detect(threadId, runId);
  yield* detector.drain;
  return yield* checked;
});

/** Adds a page ask that `setBy` raised or last updated, first raised at `minute`. */
const withPageAsk =
  (minute: number, setBy: RunId, status: ThreadAskStatus = "open") =>
  (base: OrchestrationV2ThreadProjection): OrchestrationV2ThreadProjection => ({
    ...base,
    thread: {
      ...base.thread,
      asks: [
        ...(base.thread.asks ?? []),
        {
          id: ThreadAskId.make(`page:${setBy}`),
          source: { type: "page", renderId: `layouts:${setBy}`, runId: setBy },
          text: "Pick one of 3 layouts",
          raisedAt: DateTime.formatIso(at(minute)),
          status,
        },
      ],
    },
  });

/** Adds a question (or an approval, or a sign-in) the agent asked at `minute`, still waiting. */
const withPendingRequest =
  (minute: number, kind: "user_input" | "command" | "auth_refresh" = "user_input") =>
  (base: OrchestrationV2ThreadProjection): OrchestrationV2ThreadProjection => ({
    ...base,
    runtimeRequests: [
      ...base.runtimeRequests,
      {
        id: RuntimeRequestId.make(`request:${kind}`),
        nodeId: NodeId.make("node:root"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: at(minute),
        resolvedAt: null,
      },
    ],
  });

/** Adds a link (or secret) card that `setBy` showed at `minute`, still waiting for the user. */
const withWaitingCard =
  (
    minute: number,
    setBy: RunId = runId,
    type: "link_request" | "secret_request" = "link_request",
  ) =>
  (base: OrchestrationV2ThreadProjection): OrchestrationV2ThreadProjection => {
    const card = {
      id: TurnItemId.make(`item:${type}:${setBy}`),
      threadId,
      runId: setBy,
      nodeId: NodeId.make("node:root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 140,
      status: "waiting",
      title: null,
      startedAt: at(minute),
      completedAt: null,
      updatedAt: at(minute),
    } as const;
    return {
      ...base,
      turnItems: [
        ...base.turnItems,
        type === "link_request"
          ? { ...card, type, reason: "Link the VPS to read its logs", linkStatus: "pending" }
          : {
              ...card,
              type,
              label: "Deploy token",
              reason: "Read the logs",
              secretStatus: "pending",
            },
      ],
    };
  };

describe("TurnEndAskDetector", () => {
  it.effect("raises a guarded turn-end ask from the run's final message", () =>
    Effect.gen(function* () {
      // A later run's page ask, question or link card, raised before this run's detection, does
      // not cover its ending, and neither does a page ask this run withdrew, its secret card,
      // still waiting once the run completed until the agent's call closes it, or a sign-in,
      // which only the system answers.
      const later = RunId.make("run:later");
      const harness = makeHarness(
        projection((base) =>
          withWaitingCard(
            9,
            runId,
            "secret_request",
          )(
            withWaitingCard(
              12,
              later,
            )(
              withPendingRequest(12)(
                withPendingRequest(
                  9,
                  "auth_refresh",
                )(withPageAsk(12, later)(withPageAsk(5, runId, "withdrawn")(base))),
              ),
            ),
          ),
        ),
      );
      const done = yield* detectOnce.pipe(Effect.provide(harness.layer));

      assert.equal(harness.generateTurnEndAsk.mock.calls.length, 1);
      const input = harness.generateTurnEndAsk.mock.calls[0]?.[0];
      assert.include(input?.finalMessage, ending);
      assert.equal(input?.userMessage, "Find the stale skill entries.");
      assert.deepEqual(harness.dispatched, [raised]);
      assert.deepEqual(done, [runId]);
    }),
  );

  it.effect("records the run as read when the ending does not wait on the user", () =>
    Effect.gen(function* () {
      const harness = makeHarness(projection(), { waitsOnUser: false, ask: "" });
      const done = yield* detectOnce.pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateTurnEndAsk.mock.calls.length, 1);
      assert.deepEqual(harness.dispatched, []);
      assert.deepEqual(done, [runId]);
    }),
  );

  it.effect("tries a failed read again within the window, and records it once it succeeds", () =>
    Effect.gen(function* () {
      const harness = makeHarness(projection());
      const unavailable = new TextGenerationError({
        operation: "generateTurnEndAsk",
        detail: "model unavailable",
      });
      harness.generateTurnEndAsk
        .mockImplementationOnce(() => Effect.fail(unavailable))
        .mockImplementationOnce(() => Effect.fail(unavailable));
      const done = yield* Effect.gen(function* () {
        yield* recordCheck(10);
        // The ledger fails once on reading whether the run was read, and once on marking it,
        // which does not read the run again.
        const ledger = yield* NeedsYouLedger.NeedsYouLedger;
        let readFails = 1;
        let markFails = 1;
        const busy = Effect.fail(
          new SqlError.SqlError({ reason: new SqlError.LockTimeoutError({ cause: null }) }),
        );
        const detector = yield* TurnEndAskDetector.make.pipe(
          Effect.provideService(NeedsYouLedger.NeedsYouLedger, {
            ...ledger,
            isChecked: (id) =>
              Effect.suspend(() => (readFails-- > 0 ? busy : ledger.isChecked(id))),
            markChecked: (id) =>
              Effect.suspend(() => (markFails-- > 0 ? busy : ledger.markChecked(id))),
          }),
        );
        yield* detector.detect(threadId, runId);
        yield* TestClock.adjust("1 minute");
        assert.deepEqual(yield* checked, []);
        yield* TestClock.adjust("2 minutes");
        yield* detector.drain;
        return yield* checked;
      }).pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateTurnEndAsk.mock.calls.length, 3);
      assert.deepEqual(harness.dispatched, [raised]);
      assert.deepEqual(done, [runId]);
    }),
  );

  it.effect("gives up when the window closes, without a verdict", () =>
    Effect.gen(function* () {
      const harness = makeHarness(projection());
      harness.generateTurnEndAsk.mockImplementation(() =>
        Effect.fail(
          new TextGenerationError({ operation: "generateTurnEndAsk", detail: "unsupported" }),
        ),
      );
      const done = yield* Effect.gen(function* () {
        yield* recordCheck(10);
        const detector = yield* TurnEndAskDetector.make;
        yield* detector.detect(threadId, runId);
        yield* TestClock.adjust("10 minutes");
        yield* detector.drain;
        return yield* checked;
      }).pipe(Effect.provide(harness.layer));
      assert.deepEqual(harness.dispatched, []);
      assert.deepEqual(done, []);
    }),
  );

  it.effect("does not read a run another process already read", () =>
    Effect.gen(function* () {
      const harness = makeHarness(projection());
      yield* Effect.gen(function* () {
        yield* recordCheck(10);
        const ledger = yield* NeedsYouLedger.NeedsYouLedger;
        yield* ledger.markChecked(runId);
        const detector = yield* TurnEndAskDetector.make;
        yield* detector.detect(threadId, runId);
        yield* detector.drain;
      }).pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateTurnEndAsk.mock.calls.length, 0);
    }),
  );

  // A deploy can stop the server between a run's end and its read, and a wake queued behind the
  // user's run may have started meanwhile.
  it.effect.each([
    ["ended 3 minutes before the start and was never read", 13, false, true, false],
    ["was read before the restart", 13, true, false, false],
    ["ended 11 minutes before the start", 21, false, false, false],
    [
      "ended 3 minutes before a start whose first read of the backlog failed",
      13,
      false,
      true,
      true,
    ],
  ] as const)("on start, reads a run that %s", ([, startMinute, wasRead, reads, backlogFails]) =>
    Effect.gen(function* () {
      const harness = makeHarness(projection(withWakeQueuedBehind));
      yield* TestClock.setTime(DateTime.toEpochMillis(at(startMinute)));
      yield* Effect.gen(function* () {
        const ledger = yield* NeedsYouLedger.NeedsYouLedger;
        yield* recordCheck(10);
        if (wasRead) yield* ledger.markChecked(runId);
        let failures = backlogFails ? 1 : 0;
        const detector = yield* TurnEndAskDetector.make.pipe(
          Effect.provideService(NeedsYouLedger.NeedsYouLedger, {
            ...ledger,
            pendingChecks: (since) =>
              failures-- > 0
                ? Effect.fail(
                    new SqlError.SqlError({
                      reason: new SqlError.LockTimeoutError({ cause: null }),
                    }),
                  )
                : ledger.pendingChecks(since),
          }),
        );
        const recovering = yield* Effect.forkChild(detector.recover);
        yield* TestClock.adjust("30 seconds");
        yield* Fiber.join(recovering);
        yield* detector.drain;
      }).pipe(Effect.provide(harness.layer));
      assert.deepEqual(harness.dispatched, reads ? [raised] : []);
    }),
  );

  const stopRequest: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item:stop"),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 150,
    status: "completed",
    title: null,
    startedAt: at(8),
    completedAt: at(8),
    updatedAt: at(8),
    type: "run_interrupt_request",
    message: "Stop",
  };

  // A run the detector skips is read all the same: there is nothing to try again.
  it.effect.each([
    [
      "a subagent thread",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        thread: {
          ...base.thread,
          lineage: {
            parentThreadId: ThreadId.make("thread:parent"),
            relationshipToParent: "subagent" as const,
            rootThreadId: ThreadId.make("thread:parent"),
          },
        },
      }),
    ],
    [
      "an archived thread",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        thread: { ...base.thread, archivedAt: at(11) },
      }),
    ],
    ["a pending question", withPendingRequest(9)],
    // The shell sums up one request, a later run's approval here, over the run's card.
    [
      "a link card the run left waiting, behind a later run's approval",
      (base: OrchestrationV2ThreadProjection) =>
        withPendingRequest(12, "command")(withWaitingCard(9)(base)),
    ],
    // Linking wakes the agent, which is no reply from the user.
    [
      "a link card the run left waiting that the user linked before the read",
      (base: OrchestrationV2ThreadProjection) => {
        const withCard = withWaitingCard(9)(base);
        return {
          ...withCard,
          turnItems: withCard.turnItems.map((item) =>
            item.type === "link_request"
              ? {
                  ...item,
                  status: "completed" as const,
                  linkStatus: "linked" as const,
                  completedAt: at(11),
                  updatedAt: at(11),
                }
              : item,
          ),
        };
      },
    ],
    ["a run that showed a page that asks", withPageAsk(5, runId)],
    // An earlier run first raised it; this run updated it, so its ending repeats it.
    ["a run that updated a page's ask", withPageAsk(0, runId)],
    // The user answered or dismissed the page before the run ended; the ending asks the same.
    ["a run whose page ask was answered", withPageAsk(5, runId, "answered")],
    ["a run whose page ask was dismissed", withPageAsk(5, runId, "dismissed")],
    [
      "a stopped run",
      (base: OrchestrationV2ThreadProjection) => ({ ...base, turnItems: [stopRequest] }),
    ],
    [
      "a run without a final message",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        messages: base.messages.filter((candidate) => candidate.role === "user"),
      }),
    ],
    [
      "a user reply after the run",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        messages: [...base.messages, message("user-2", "user", 12, "Yes, delete them.")],
      }),
    ],
  ] as const)("skips %s", ([, change]) =>
    Effect.gen(function* () {
      const harness = makeHarness(projection(change));
      const done = yield* detectOnce.pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateTurnEndAsk.mock.calls.length, 0);
      assert.deepEqual(harness.dispatched, []);
      assert.deepEqual(done, [runId]);
    }),
  );
});
