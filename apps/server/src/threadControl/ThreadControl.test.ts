import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2UserInputQuestion,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadControl from "./ThreadControl.ts";

const environmentId = EnvironmentId.make("environment:thread-control");
const projectId = ProjectId.make("project:thread-control");
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadControl.layer.pipe(
  Layer.provideMerge(ThreadManagementService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-control" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
      CommandReceiptStore.layer,
      ProjectStore.layer,
      ServerSettings.layerTest(),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      NodeCrypto.layer,
    ),
  ),
  Layer.provideMerge(layerDatabase),
);

const question = (
  id: string,
  overrides: Partial<OrchestrationV2UserInputQuestion> = {},
): OrchestrationV2UserInputQuestion => ({
  id,
  header: "Runner",
  question: "Which test runner?",
  options: [
    { label: "Vitest", description: "Fast", value: "vitest" },
    { label: "Jest", description: "Familiar" },
  ],
  ...overrides,
});

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const now = yield* DateTime.now;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`project:${threadId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(now),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Fork",
        workspaceRoot: "/tmp/thread-control",
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Pick a runner",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const startRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`start:${threadId}`),
      threadId,
      messageId: MessageId.make(`start:${threadId}`),
      text: "Set up tests",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
  });

const write = (threadId: ThreadId, events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: events.map(
        (event, index) =>
          ({
            ...event,
            id: EventId.make(`seed:${threadId}:${event.type}:${index}`),
          }) as OrchestrationV2DomainEvent,
      ),
    });
  });

/**
 * A running thread with a pending runtime request: a question with its turn item, or an approval.
 * Message-capability questions don't block the run; live ones do but can't be answered here.
 */
const seedPendingRequest = (
  threadId: ThreadId,
  request: { readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion> } | "approval",
  capability: "message" | "live" = "message",
) =>
  Effect.gen(function* () {
    yield* createThread(threadId);
    const run = yield* startRun(threadId);
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make(`request:${threadId}`);
    yield* write(threadId, [
      {
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: request === "approval" ? "command" : "user_input",
          status: "pending",
          responseCapability:
            capability === "message"
              ? { type: "message" }
              : { type: "live", providerSessionId: ProviderSessionId.make("session:unused") },
          createdAt: now,
          resolvedAt: null,
        },
      },
      ...(request === "approval"
        ? []
        : [
            {
              type: "turn-item.updated" as const,
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item:${threadId}`),
                type: "user_input_request" as const,
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 10,
                status: "running" as const,
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                questions: request.questions,
              },
            },
          ]),
    ]);
    return requestId;
  });

const projection = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );

it.effect("answers a single question with the option the reply names, once per reply id", () =>
  Effect.gen(function* () {
    const control = yield* ThreadControl.ThreadControl;
    const threadId = ThreadId.make("thread:answer");
    const requestId = yield* seedPendingRequest(threadId, {
      questions: [question("runner", { allowCustomAnswer: false })],
    });

    const reply = { threadId, replyId: "reply-1", text: "Vitest please" };
    assert.deepEqual(yield* control.reply(reply), { outcome: "answered" });
    const answered = (yield* projection(threadId)).runtimeRequests.find(
      (request) => request.id === requestId,
    );
    assert.equal(answered?.status, "resolved");
    assert.deepEqual(answered?.answers, { runner: "vitest" });

    // The question is gone now; a retry must not turn the text into a new message.
    const messages = (yield* projection(threadId)).messages.length;
    assert.deepEqual(yield* control.reply(reply), { outcome: "already_delivered" });
    assert.equal((yield* projection(threadId)).messages.length, messages);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects replies the notification can't deliver", () =>
  Effect.gen(function* () {
    const control = yield* ThreadControl.ThreadControl;
    const cases = [
      ["approval", "approval", "approval_pending"],
      [
        "closed-question",
        { questions: [question("runner", { allowCustomAnswer: false })] },
        "no_matching_option",
      ],
      [
        "two-questions",
        { questions: [question("runner"), question("watch", { question: "Watch mode?" })] },
        "question_needs_client",
      ],
    ] as const;
    for (const [name, request, reason] of cases) {
      const threadId = ThreadId.make(`thread:${name}`);
      yield* seedPendingRequest(threadId, request);
      assert.deepEqual(
        yield* control.reply({ threadId, replyId: `reply:${name}`, text: "Mocha" }),
        { outcome: "rejected", reason },
      );
      const shell = yield* Effect.flatMap(ThreadManagementService.ThreadManagementService, (t) =>
        t.getThreadShell(threadId),
      );
      assert.equal(shell?.pendingRuntimeRequest?.id, RuntimeRequestId.make(`request:${threadId}`));
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("sends a reply to an idle thread as its next message, once per reply id", () =>
  Effect.gen(function* () {
    const control = yield* ThreadControl.ThreadControl;
    const threadId = ThreadId.make("thread:sent");
    yield* createThread(threadId);

    const reply = { threadId, replyId: "reply-2", text: "Run the tests first" };
    assert.deepEqual(yield* control.reply(reply), { outcome: "sent" });
    assert.deepEqual(yield* control.reply(reply), { outcome: "already_delivered" });
    const { messages, runs } = yield* projection(threadId);
    assert.deepEqual(
      messages.map((message) => [message.role, message.text, message.creationSource]),
      [["user", "Run the tests first", "mobile"]],
    );
    assert.equal(runs.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stops a running thread and reports a missing one", () =>
  Effect.gen(function* () {
    const control = yield* ThreadControl.ThreadControl;
    const threadId = ThreadId.make("thread:stop");
    yield* createThread(threadId);
    yield* startRun(threadId);

    yield* control.stop(threadId);
    assert.deepEqual(
      (yield* projection(threadId)).runs.map((run) => run.status),
      ["interrupted"],
    );

    const missing = yield* Effect.flip(control.stop(ThreadId.make("thread:missing")));
    assert.equal(missing._tag, "ThreadControlThreadNotFoundError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("summarizes one thread with its question and the agent's latest words", () =>
  Effect.gen(function* () {
    const control = yield* ThreadControl.ThreadControl;
    const threadId = ThreadId.make("thread:glance");
    yield* seedPendingRequest(threadId, { questions: [question("runner")] }, "live");
    const run = (yield* projection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* write(threadId, [
      {
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: MessageId.make("message:agent"),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          role: "assistant",
          text: "## Plan\n\nI'll add **Vitest** and a `test` script.\n\n```sh\npnpm add vitest\n```",
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: now,
          updatedAt: now,
        },
      },
    ]);

    const glance = yield* control.getGlance(threadId);
    assert.deepInclude(glance, {
      environmentId,
      threadId,
      projectTitle: "Fork",
      threadTitle: "Pick a runner",
      modelTitle: "gpt-5.4",
      phase: "waiting_for_input",
      excerpt: "Plan I'll add Vitest and a test script.",
      question: { text: "Which test runner?", options: ["Vitest", "Jest"], allowsFreeText: true },
      canStop: true,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lists threads that need the user or work, then the last day's unsettled results", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:list-base");
    yield* createThread(threadId);
    const base = (yield* Effect.flatMap(ThreadManagementService.ThreadManagementService, (t) =>
      t.getThreadShell(threadId),
    ))!;
    const now = DateTime.makeUnsafe("2026-10-26T12:00:00.000Z");
    const hoursAgo = (hours: number) => DateTime.subtract(now, { hours });
    const shell = (
      id: string,
      hours: number,
      overrides: Partial<OrchestrationV2ThreadShell>,
    ): OrchestrationV2ThreadShell => ({
      ...base,
      id: ThreadId.make(id),
      title: id,
      updatedAt: hoursAgo(hours),
      ...overrides,
    });
    const pending = (kind: "user_input" | "command") => ({
      id: RuntimeRequestId.make(`request:${kind}`),
      kind,
      createdAt: now,
    });

    const list = ThreadControl.buildThreadGlanceList({
      environmentId,
      projects: [{ id: projectId, title: "Fork" }],
      nowMs: DateTime.toEpochMillis(now),
      threads: [
        shell("done-recently", 2, { status: "completed" }),
        shell("running", 1, { status: "running" }),
        shell("failed", 3, { status: "failed" }),
        shell("asks", 5, { status: "running", pendingRuntimeRequest: pending("user_input") }),
        shell("approval", 0, { status: "running", pendingRuntimeRequest: pending("command") }),
        shell("done-yesterday", 30, { status: "completed" }),
        shell("settled", 1, { status: "completed", settledOverride: "settled" }),
        shell("archived", 1, { status: "running", archivedAt: hoursAgo(1) }),
        shell("idle", 1, { status: "idle" }),
        shell("other-project", 1, { status: "running", projectId: ProjectId.make("gone") }),
      ],
    });
    assert.deepEqual(
      list.threads.map((row) => [row.threadTitle, row.phase]),
      [
        ["approval", "waiting_for_approval"],
        ["asks", "waiting_for_input"],
        ["failed", "failed"],
        ["running", "running"],
        ["done-recently", "completed"],
      ],
    );
  }).pipe(Effect.provide(layerTest)),
);

it("matches dictated replies to a question's options", () => {
  const runner = question("runner");
  const closed = question("runner", { allowCustomAnswer: false });
  const multi = question("runner", { multiSelect: true });
  assert.deepEqual(
    [
      ThreadControl.matchUserInputAnswer(runner, "jest."),
      ThreadControl.matchUserInputAnswer(runner, "Option 1"),
      ThreadControl.matchUserInputAnswer(runner, "two"),
      ThreadControl.matchUserInputAnswer(runner, "let's go with jest then"),
      ThreadControl.matchUserInputAnswer(runner, " Whatever is fastest "),
      ThreadControl.matchUserInputAnswer(closed, "Whatever is fastest"),
      ThreadControl.matchUserInputAnswer(multi, "vitest"),
    ],
    ["Jest", "vitest", "Jest", "Jest", "Whatever is fastest", null, ["vitest"]],
  );
});
