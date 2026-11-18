import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  ComposerContextId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadAskId,
  ThreadId,
  TurnItemId,
  type OrchestrationMessageContext,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for asks"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-asks" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:asks");
const pageSendContext: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make("page-layouts"),
      label: "Layouts",
      kind: "html-render",
      renderId: "render:layout",
      title: "Layouts",
    },
  ],
};

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-asks"),
    threadId,
    projectId: ProjectId.make("project:asks"),
    title: "Pick a layout",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return orchestrator;
});

const raisePageAsk = (orchestrator: Orchestrator.OrchestratorV2["Service"], id: string) =>
  orchestrator.dispatch({
    type: "thread.ask.raise",
    commandId: CommandId.make(`raise:${id}`),
    threadId,
    askId: ThreadAskId.make(id),
    source: { type: "page", renderId: `render:${id}` },
    text: `Pick one of 3 layouts (${id})`,
  });

const send = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  id: string,
  options: {
    readonly createdBy?: "user" | "agent";
    readonly creationSource?: "web" | "mcp";
    readonly queued?: boolean;
    readonly text?: string;
    readonly context?: OrchestrationMessageContext;
  } = {},
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId,
    messageId: MessageId.make(id),
    text: options.text ?? `Message ${id}`,
    ...(options.context === undefined ? {} : { context: options.context }),
    attachments: [],
    dispatchMode: options.queued ? { type: "queue_after_active" } : { type: "defer_start" },
    createdBy: options.createdBy ?? "user",
    creationSource: options.creationSource ?? "web",
  });

const openAskIds = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const full = ProjectionStore.threadShellFromProjection(
    yield* projections.getThreadProjection(threadId),
  );
  const listed = yield* projections.getThreadShell(threadId);
  const candidates = yield* projections.getSettlementCandidates(threadId);
  const ids = (asks: ReadonlyArray<{ readonly id: string }> | undefined) =>
    (asks ?? []).map((ask) => ask.id);
  // Every shell path agrees, so lists, the thread view and auto-settle see the same asks.
  assert.deepEqual(ids(listed?.openAsks), ids(full.openAsks));
  if (candidates.length > 0) assert.deepEqual(ids(candidates[0]?.openAsks), ids(full.openAsks));
  return ids(full.openAsks);
});

it.effect("a user's message answers open asks; an agent's or an empty one does not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* raisePageAsk(orchestrator, "layout");
    assert.deepEqual(yield* openAskIds, ["layout"]);

    yield* send(orchestrator, "from-agent", { createdBy: "agent", creationSource: "mcp" });
    assert.deepEqual(yield* openAskIds, ["layout"]);
    yield* send(orchestrator, "empty", { text: "" });
    assert.deepEqual(yield* openAskIds, ["layout"]);

    // A reply with only context records, here the page it came from, still answers.
    yield* send(orchestrator, "from-user", { text: "", context: pageSendContext });
    assert.deepEqual(yield* openAskIds, []);
    const ask = (yield* projections.getThread(threadId)).asks?.[0];
    assert.equal(ask?.status, "answered");
    assert.equal(ask?.answeredBy, MessageId.make("from-user"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("cancelling the queued reply that answered an ask opens it again", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* send(orchestrator, "first");
    yield* raisePageAsk(orchestrator, "layout");
    yield* send(orchestrator, "queued-reply", { queued: true });
    assert.deepEqual(yield* openAskIds, []);

    const queued = (yield* projections.getThreadProjection(threadId)).runs.find(
      (run) => run.status === "queued",
    );
    assert.isDefined(queued);
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel"),
      threadId,
      runId: queued.id,
    });
    assert.deepEqual(yield* openAskIds, ["layout"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a turn-end ask lands past a cancelled queued reply, an agent's message or a retry", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* send(orchestrator, "first");
    const run = (yield* projections.getThreadProjection(threadId)).runs[0];
    assert.isDefined(run);
    yield* TestClock.adjust("1 minute");
    const completedAt = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:first-completed"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: completedAt,
      payload: { ...run, status: "completed", completedAt },
    });
    yield* TestClock.adjust("1 minute");
    // An agent's message starts the next run, and the user's reply queues behind it.
    yield* send(orchestrator, "from-agent", { createdBy: "agent", creationSource: "mcp" });
    yield* send(orchestrator, "queued-reply", { queued: true });
    const queued = (yield* projections.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.status === "queued",
    );
    assert.isDefined(queued);
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel"),
      threadId,
      runId: queued.id,
    });
    const userMessage = (
      id: string,
      content: Partial<
        Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context">
      >,
    ) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        const at = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make(`event:${id}`),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: {
            id: MessageId.make(id),
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: "",
            attachments: [],
            ...content,
            streaming: false,
            createdBy: "user",
            creationSource: "server",
            createdAt: at,
            updatedAt: at,
          },
        });
      });
    // Codex's automatic retry and its Resume store a user message with no content.
    yield* userMessage("codex-overload-retry", {});
    // Blank by JavaScript's trim, like `isUserReply` reads it.
    yield* userMessage("no-break-space", { text: " " });

    const statements: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
    yield* orchestrator
      .dispatch({
        type: "thread.ask.raise",
        commandId: CommandId.make("raise:turn"),
        threadId,
        askId: ThreadAskId.make("turn"),
        source: { type: "turn_end", runId: run.id },
        text: "Delete them on those four hosts?",
      })
      .pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          statements.push(statement.compile());
          return Effect.succeed(statement);
        }),
      );
    assert.deepEqual(yield* openAskIds, ["turn"]);
    // Under the command lock, the reply read starts where the run ended, not at the transcript's end.
    const replyRead = statements.find(([query]) => query.includes("'$.createdBy') = 'user'"));
    assert.isDefined(replyRead);
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${replyRead[0]}`,
      replyRead[1],
    );
    assert.isTrue(
      plan.some((row) => /thread_created_idx \(thread_id=\? AND created_at>\?\)/.test(row.detail)),
      JSON.stringify(plan),
    );

    // A reply with only attachments or only context records still counts.
    yield* userMessage("attachment-only", {
      attachments: [
        {
          type: "file",
          id: ChatAttachmentId.make("notes"),
          name: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 12,
        },
      ],
    });
    assert.equal(
      (yield* projections.getLatestUserReply(threadId, completedAt))?.id,
      "attachment-only",
    );
    yield* userMessage("context-only", { context: pageSendContext });
    assert.equal(
      (yield* projections.getLatestUserReply(threadId, completedAt))?.id,
      "context-only",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("answering a question card the agent did not wait on answers open asks", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* raisePageAsk(orchestrator, "layout");
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make("request:color");
    const nodeId = NodeId.make("node:color");
    yield* projections.apply({
      id: EventId.make("event:color-request"),
      type: "runtime-request.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:color-item"),
      type: "turn-item.updated",
      threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:color"),
        type: "user_input_request",
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        requestId,
        questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
      },
    });

    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-color"),
      threadId,
      requestId,
      answers: { color: "Blue" },
    });
    assert.deepEqual(yield* openAskIds, []);
    assert.equal(
      (yield* projections.getThread(threadId)).asks?.[0]?.answeredBy,
      MessageId.make(`async-answer:${requestId}`),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("No reply needed and settling end asks; a new ask unsettles the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* raisePageAsk(orchestrator, "one");
    yield* raisePageAsk(orchestrator, "two");
    yield* orchestrator.dispatch({
      type: "thread.ask.dismiss",
      commandId: CommandId.make("dismiss-one"),
      threadId,
      askId: ThreadAskId.make("one"),
    });
    assert.deepEqual(yield* openAskIds, ["two"]);
    // A second device's dismiss of the same ask is not an error.
    yield* orchestrator.dispatch({
      type: "thread.ask.dismiss",
      commandId: CommandId.make("dismiss-one-again"),
      threadId,
      askId: ThreadAskId.make("one"),
    });

    // Automatic settlement checked a snapshot taken in the millisecond the ask came in.
    const autoSettle = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("auto-settle"),
        threadId,
        snapshotAt: yield* DateTime.now,
      }),
    );
    assert.isTrue(Exit.isFailure(autoSettle));
    assert.deepEqual(yield* openAskIds, ["two"]);

    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle"),
      threadId,
    });
    assert.deepEqual(yield* openAskIds, []);

    yield* raisePageAsk(orchestrator, "three");
    const thread = yield* projections.getThread(threadId);
    assert.isNull(thread.settledOverride);
    assert.deepEqual(yield* openAskIds, ["three"]);
  }).pipe(Effect.provide(layerTest)),
);
