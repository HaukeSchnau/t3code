import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import {
  ProviderEventIngestorV2,
  layer as providerEventIngestorLayer,
} from "./ProviderEventIngestor.ts";
import {
  ProviderEventJournal,
  ProviderEventJournalLive,
  type ProviderEventJournalInput,
} from "./ProviderEventJournal.ts";
import { replayAcceptedProviderEvents } from "./ProviderEventJournalReplay.ts";
import {
  ProjectionStoreApplyEventError,
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "./ProjectionStore.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const decodeSavedMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ message: Schema.Struct({ text: Schema.String }) })),
);
const decodeSavedSubagent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ subagent: Schema.Struct({ prompt: Schema.String }) })),
);

const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: `project:${threadId}` as OrchestrationV2AppThread["projectId"],
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreatedEvent(
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${thread.id}:created`),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  };
}

function makeProviderThread(input: {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly status?: OrchestrationV2ProviderThread["status"];
  readonly lastRunOrdinal?: number | null;
}): OrchestrationV2ProviderThread {
  return {
    id: input.providerThreadId,
    driver: providerDriver,
    providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: input.status ?? "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: input.lastRunOrdinal ?? 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function providerThreadAdapterEvent(providerThread: OrchestrationV2ProviderThread): {
  readonly type: "provider_thread.updated";
  readonly driver: typeof providerDriver;
  readonly providerThread: OrchestrationV2ProviderThread;
} {
  return { type: "provider_thread.updated", driver: providerDriver, providerThread };
}

function providerThreadDomainEvent(
  providerThread: OrchestrationV2ProviderThread,
  id: string,
  now: DateTime.Utc,
): OrchestrationV2DomainEvent {
  const threadId = providerThread.appThreadId;
  if (threadId === null) {
    throw new Error("Provider-thread journal fixtures require an app thread id.");
  }
  return {
    id: EventId.make(id),
    type: "provider-thread.updated",
    threadId,
    driver: providerDriver,
    providerInstanceId,
    occurredAt: now,
    payload: providerThread,
  };
}

function makeRun(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly now: DateTime.Utc;
}): OrchestrationV2Run {
  return {
    id: input.runId,
    threadId: input.threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: input.providerThreadId,
    userMessageId: MessageId.make(`message:${input.runId}:user`),
    rootNodeId: null,
    activeAttemptId: input.attemptId,
    status: "completed",
    queuePosition: null,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.now,
    checkpointId: null,
    contextHandoffId: null,
  };
}

const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const journalProvided = ProviderEventJournalLive.pipe(Layer.provide(databaseLayer));
const eventSinkProvided = eventSinkLayer.pipe(
  Layer.provide(Layer.mergeAll(storesProvided, journalProvided)),
);
const ingestorProvided = providerEventIngestorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(storesProvided, eventSinkProvided, idAllocatorLayer, journalProvided),
  ),
);
const TestLayer = Layer.mergeAll(
  storesProvided,
  journalProvided,
  eventSinkProvided,
  idAllocatorLayer,
  ingestorProvided,
);
const rollbackProjectionLayer = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStoreV2;
    return {
      ...projectionStore,
      apply: (event: OrchestrationV2DomainEvent) =>
        Effect.fail(new ProjectionStoreApplyEventError({ eventType: event.type })),
    };
  }),
).pipe(Layer.provide(projectionStoreProvided));
const RollbackTestLayer = Layer.mergeAll(
  storesProvided,
  journalProvided,
  eventSinkLayer.pipe(
    Layer.provide(Layer.mergeAll(storesProvided, rollbackProjectionLayer, journalProvided)),
  ),
);

const readThreadEvents = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const events = yield* (yield* EventStoreV2).read({ threadId }).pipe(Stream.runCollect);
    return Array.from(events);
  });

const accept = Effect.fn("test.acceptProviderEvent")(function* (input: {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly event: ProviderEventJournalInput["event"];
}) {
  const journal = yield* ProviderEventJournal;
  assert.isTrue(
    yield* journal.accept({
      providerSessionId: input.providerSessionId,
      providerInstanceId,
      threadId: input.threadId,
      event: input.event,
    }),
  );
  const accepted = journal.getAccepted(input.event);
  assert.isDefined(accepted);
  return accepted!.id;
});

it.effect("replays an accepted event through the ingestor after an intake crash", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const ingestor = yield* ProviderEventIngestorV2;
    const journal = yield* ProviderEventJournal;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:event-sink-journal-replay");
    const providerSessionId = ProviderSessionId.make("provider-session:event-sink-journal-replay");
    const providerThread = makeProviderThread({
      threadId,
      providerThreadId: ProviderThreadId.make("provider-thread:event-sink-journal-replay"),
      providerSessionId,
      now,
    });
    const event = providerThreadAdapterEvent(providerThread);
    yield* sink.write({ events: [threadCreatedEvent(makeThread(threadId, now), now)] });
    const acceptedId = yield* accept({ threadId, providerSessionId, event });

    const stored = yield* ingestor.ingestNormalized({
      acceptedProviderEventId: acceptedId,
      providerSessionId,
      providerInstanceId,
      threadId,
      event,
    });
    assert.lengthOf(stored, 1);
    assert.isFalse(yield* journal.isPending(acceptedId));
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("keeps an accepted journal entry pending when projection commits roll back", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const journal = yield* ProviderEventJournal;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:event-sink-journal-rollback");
    const providerSessionId = ProviderSessionId.make(
      "provider-session:event-sink-journal-rollback",
    );
    const providerThread = makeProviderThread({
      threadId,
      providerThreadId: ProviderThreadId.make("provider-thread:event-sink-journal-rollback"),
      providerSessionId,
      now,
    });
    const event = providerThreadAdapterEvent(providerThread);
    const acceptedId = yield* accept({ threadId, providerSessionId, event });
    const failed = yield* Effect.exit(
      sink.write({
        acceptedProviderEventId: acceptedId,
        events: [
          {
            id: EventId.make("event:event-sink-journal-rollback:metadata"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: makeThread(threadId, now),
          },
        ],
      }),
    );
    assert.equal(failed._tag, "Failure");
    assert.isTrue(yield* journal.isPending(acceptedId));
    assert.isEmpty(yield* readThreadEvents(threadId));
  }).pipe(Effect.provide(Layer.fresh(RollbackTestLayer))),
);

it.effect("does not project or append an exact duplicate after journal retirement", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const journal = yield* ProviderEventJournal;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:event-sink-journal-duplicate");
    const providerSessionId = ProviderSessionId.make(
      "provider-session:event-sink-journal-duplicate",
    );
    const thread = makeThread(threadId, now);
    const providerThread = makeProviderThread({
      threadId,
      providerThreadId: ProviderThreadId.make("provider-thread:event-sink-journal-duplicate"),
      providerSessionId,
      now,
    });
    const adapterEvent = providerThreadAdapterEvent(providerThread);
    yield* sink.write({ events: [threadCreatedEvent(thread, now)] });
    const acceptedId = yield* accept({ threadId, providerSessionId, event: adapterEvent });
    const domainEvent = providerThreadDomainEvent(
      providerThread,
      "event:event-sink-journal-duplicate:thread",
      now,
    );
    const first = yield* sink.write({ acceptedProviderEventId: acceptedId, events: [domainEvent] });
    const retry = yield* sink.write({ acceptedProviderEventId: acceptedId, events: [domainEvent] });
    assert.lengthOf(first, 1);
    assert.isEmpty(retry);
    assert.lengthOf(yield* readThreadEvents(threadId), 2);
    assert.isFalse(yield* journal.isPending(acceptedId));
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("retires skipped earlier snapshots when a later entity snapshot is committed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const journal = yield* ProviderEventJournal;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:event-sink-journal-latest");
    const providerSessionId = ProviderSessionId.make("provider-session:event-sink-journal-latest");
    const providerThreadId = ProviderThreadId.make("provider-thread:event-sink-journal-latest");
    yield* sink.write({ events: [threadCreatedEvent(makeThread(threadId, now), now)] });
    const firstThread = makeProviderThread({ threadId, providerThreadId, providerSessionId, now });
    const latestThread = makeProviderThread({
      threadId,
      providerThreadId,
      providerSessionId,
      now,
      status: "active",
      lastRunOrdinal: 2,
    });
    const firstEvent = providerThreadAdapterEvent(firstThread);
    const latestEvent = providerThreadAdapterEvent(latestThread);
    const firstId = yield* accept({ threadId, providerSessionId, event: firstEvent });
    const latestId = yield* accept({ threadId, providerSessionId, event: latestEvent });
    yield* sink.write({
      acceptedProviderEventId: latestId,
      events: [providerThreadDomainEvent(latestThread, "event:event-sink-journal-latest", now)],
    });
    const journalRows = yield* journal.readPending({
      throughSequence: yield* journal.latestSequence,
    });
    assert.isEmpty(journalRows);
    assert.isFalse(yield* journal.isPending(firstId));
    assert.isFalse(yield* journal.isPending(latestId));
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("replays durable message and subagent snapshots exactly once", () =>
  Effect.gen(function* () {
    const journal = yield* ProviderEventJournal;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:event-sink-journal-durable-bytes");
    const providerSessionId = ProviderSessionId.make(
      "provider-session:event-sink-journal-durable-bytes",
    );
    const runId = RunId.make("run:event-sink-journal-durable-bytes");
    const nodeId = NodeId.make("node:event-sink-journal-durable-bytes");
    const message: OrchestrationV2ConversationMessage = {
      id: MessageId.make("message:event-sink-journal-durable-bytes"),
      threadId,
      runId,
      nodeId,
      role: "assistant",
      text: "saved before the runtime process stopped",
      attachments: [],
      streaming: false,
      createdBy: "agent",
      creationSource: "provider",
      createdAt: now,
      updatedAt: now,
    };
    const subagent: OrchestrationV2Subagent = {
      id: nodeId,
      threadId,
      runId,
      parentNodeId: NodeId.make("node:event-sink-journal-durable-parent"),
      origin: "app_owned",
      createdBy: "system",
      driver: providerDriver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "saved subagent",
      title: null,
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    const messageEvent = { type: "message.updated" as const, driver: providerDriver, message };
    const subagentEvent = { type: "subagent.updated" as const, driver: providerDriver, subagent };
    assert.isTrue(
      yield* journal.accept({
        providerSessionId,
        providerInstanceId,
        threadId,
        event: messageEvent,
      }),
    );
    assert.isTrue(
      yield* journal.accept({
        providerSessionId,
        providerInstanceId,
        threadId,
        event: subagentEvent,
      }),
    );
    const rows = yield* sql<{ event_json: string }>`
      SELECT event_json FROM provider_event_journal ORDER BY sequence
    `;
    const savedMessage = yield* decodeSavedMessage(rows[0]!.event_json);
    const savedSubagent = yield* decodeSavedSubagent(rows[1]!.event_json);
    assert.equal(savedMessage.message.text, message.text);
    assert.equal(savedSubagent.subagent.prompt, subagent.prompt);

    const firstReplay = yield* replayAcceptedProviderEvents;
    assert.equal(firstReplay.replayedEventCount, 2);
    const stored = yield* readThreadEvents(threadId);
    assert.deepEqual(
      stored.map((entry) => entry.event.type),
      ["message.updated", "subagent.updated"],
    );
    assert.isFalse(yield* journal.isPending(journal.getAccepted(messageEvent)!.id));
    assert.isFalse(yield* journal.isPending(journal.getAccepted(subagentEvent)!.id));

    const secondReplay = yield* replayAcceptedProviderEvents;
    assert.equal(secondReplay.replayedEventCount, 0);
    assert.lengthOf(yield* readThreadEvents(threadId), 2);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("maps shared-session provider turns to their projected provider thread", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const journal = yield* ProviderEventJournal;
    const now = yield* DateTime.now;
    const owningThreadId = ThreadId.make("thread:event-sink-journal-shared-owner");
    const contextThreadId = ThreadId.make("thread:event-sink-journal-shared-context");
    const providerSessionId = ProviderSessionId.make("provider-session:event-sink-journal-shared");
    const providerThreadId = ProviderThreadId.make("provider-thread:event-sink-journal-shared");
    const providerTurnId = ProviderTurnId.make("provider-turn:event-sink-journal-shared");
    const nodeId = NodeId.make("node:event-sink-journal-shared");
    const providerThread = makeProviderThread({
      threadId: owningThreadId,
      providerThreadId,
      providerSessionId,
      now,
    });
    yield* sink.write({
      events: [
        threadCreatedEvent(makeThread(owningThreadId, now), now),
        providerThreadDomainEvent(providerThread, "event:event-sink-journal-shared:thread", now),
      ],
    });
    const providerTurn = {
      id: providerTurnId,
      providerThreadId,
      nodeId,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
    };
    const event = { type: "provider_turn.updated" as const, driver: providerDriver, providerTurn };
    assert.isTrue(
      yield* journal.accept({
        providerSessionId,
        providerInstanceId,
        threadId: contextThreadId,
        event,
      }),
    );
    const accepted = journal.getAccepted(event);
    assert.isDefined(accepted);

    const replay = yield* replayAcceptedProviderEvents;
    assert.equal(replay.replayedEventCount, 1);
    assert.isFalse(yield* journal.isPending(accepted!.id));
    const stored = yield* readThreadEvents(owningThreadId);
    const providerTurnEvent = stored.at(-1);
    assert.isDefined(providerTurnEvent);
    assert.equal(providerTurnEvent!.event.type, "provider-turn.updated");
    assert.equal(providerTurnEvent!.event.threadId, owningThreadId);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("retires cleanup snapshots after direct cancellation is projected", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const journal = yield* ProviderEventJournal;
    const projections = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const completedAt = DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 1_000);
    const threadId = ThreadId.make("thread:event-sink-journal-direct-cleanup");
    const providerSessionId = ProviderSessionId.make(
      "provider-session:event-sink-journal-direct-cleanup",
    );
    const providerThreadId = ProviderThreadId.make(
      "provider-thread:event-sink-journal-direct-cleanup",
    );
    const providerTurnId = ProviderTurnId.make("provider-turn:event-sink-journal-direct-cleanup");
    const nodeId = NodeId.make("node:event-sink-journal-direct-cleanup");
    const requestId = RuntimeRequestId.make("request:event-sink-journal-direct-cleanup");
    const turnItemId = TurnItemId.make("turn-item:event-sink-journal-direct-cleanup");
    const pendingRequest: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: { type: "live", providerSessionId },
      createdAt: now,
      resolvedAt: null,
    };
    const pendingNode: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const pendingApproval: OrchestrationV2TurnItem = {
      id: turnItemId,
      threadId,
      runId: null,
      nodeId,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "approval_request",
      requestId,
      requestKind: "command",
    };
    const cancelledRequest = {
      ...pendingRequest,
      status: "cancelled" as const,
      resolvedAt: completedAt,
    };
    const cancelledNode = { ...pendingNode, status: "cancelled" as const, completedAt };
    const cancelledApproval = {
      ...pendingApproval,
      status: "cancelled" as const,
      completedAt,
      updatedAt: completedAt,
    };
    const pendingEvents = [
      {
        type: "runtime_request.updated" as const,
        driver: providerDriver,
        runtimeRequest: pendingRequest,
        threadId,
      },
      { type: "node.updated" as const, driver: providerDriver, node: pendingNode },
      { type: "turn_item.updated" as const, driver: providerDriver, turnItem: pendingApproval },
    ];
    const pendingIds = [];
    for (const event of pendingEvents) {
      assert.isTrue(
        yield* journal.accept({
          providerSessionId,
          providerInstanceId,
          threadId,
          event,
        }),
      );
      const accepted = journal.getAccepted(event);
      assert.isDefined(accepted);
      pendingIds.push(accepted!.id);
    }
    yield* sink.write({
      events: [
        threadCreatedEvent(makeThread(threadId, now), now),
        {
          id: EventId.make("event:event-sink-journal-direct-cleanup:request-pending"),
          type: "runtime-request.updated",
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: pendingRequest,
        },
        {
          id: EventId.make("event:event-sink-journal-direct-cleanup:node-pending"),
          type: "node.updated",
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: pendingNode,
        },
        {
          id: EventId.make("event:event-sink-journal-direct-cleanup:item-pending"),
          type: "turn-item.updated",
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: pendingApproval,
        },
      ],
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:event-sink-journal-direct-cleanup:request-cancelled"),
          type: "runtime-request.updated",
          threadId,
          providerInstanceId,
          occurredAt: completedAt,
          payload: cancelledRequest,
        },
        {
          id: EventId.make("event:event-sink-journal-direct-cleanup:node-cancelled"),
          type: "node.updated",
          threadId,
          providerInstanceId,
          occurredAt: completedAt,
          payload: cancelledNode,
        },
        {
          id: EventId.make("event:event-sink-journal-direct-cleanup:item-cancelled"),
          type: "turn-item.updated",
          threadId,
          providerInstanceId,
          occurredAt: completedAt,
          payload: cancelledApproval,
        },
      ],
    });

    const beforeReplay = yield* projections.getThreadProjection(threadId);
    assert.equal(
      beforeReplay.runtimeRequests.find((request) => request.id === requestId)?.status,
      "cancelled",
    );
    assert.equal(beforeReplay.nodes.find((node) => node.id === nodeId)?.status, "cancelled");
    assert.equal(
      beforeReplay.turnItems.find((item) => item.id === turnItemId)?.status,
      "cancelled",
    );

    const replay = yield* replayAcceptedProviderEvents;
    assert.equal(replay.replayedEventCount, 0);
    for (const pendingId of pendingIds) assert.isFalse(yield* journal.isPending(pendingId));
    assert.lengthOf(yield* readThreadEvents(threadId), 7);
    const afterReplay = yield* projections.getThreadProjection(threadId);
    assert.equal(
      afterReplay.runtimeRequests.find((request) => request.id === requestId)?.status,
      "cancelled",
    );
    assert.equal(afterReplay.nodes.find((node) => node.id === nodeId)?.status, "cancelled");
    assert.equal(afterReplay.turnItems.find((item) => item.id === turnItemId)?.status, "cancelled");
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("retires stale provider-thread ownership events without projecting them", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const journal = yield* ProviderEventJournal;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:event-sink-journal-stale-owner");
    const providerSessionId = ProviderSessionId.make(
      "provider-session:event-sink-journal-stale-owner",
    );
    const providerThreadId = ProviderThreadId.make(
      "provider-thread:event-sink-journal-stale-owner",
    );
    const runId = RunId.make("run:event-sink-journal-stale-owner");
    const attemptId = RunAttemptId.make("attempt:event-sink-journal-stale-owner");
    const replacementAttemptId = RunAttemptId.make(
      "attempt:event-sink-journal-stale-owner-replacement",
    );
    const thread = makeThread(threadId, now);
    const providerThread = makeProviderThread({
      threadId,
      providerThreadId,
      providerSessionId,
      now,
    });
    yield* sink.write({
      events: [
        threadCreatedEvent(thread, now),
        {
          id: EventId.make("event:event-sink-journal-stale-owner:run"),
          type: "run.created",
          threadId,
          runId,
          providerInstanceId,
          occurredAt: now,
          payload: makeRun({ threadId, runId, attemptId, providerThreadId, now }),
        },
        providerThreadDomainEvent(
          providerThread,
          "event:event-sink-journal-stale-owner:thread",
          now,
        ),
      ],
    });
    const adapterEvent = providerThreadAdapterEvent(providerThread);
    const acceptedId = yield* accept({ threadId, providerSessionId, event: adapterEvent });
    const stale = yield* sink.writeIfProviderThreadOwner({
      acceptedProviderEventId: acceptedId,
      providerThreadId,
      runId,
      activeAttemptId: replacementAttemptId,
      expectedLastRunOrdinal: 1,
      events: [
        providerThreadDomainEvent(
          providerThread,
          "event:event-sink-journal-stale-owner:ignored",
          now,
        ),
      ],
    });
    assert.isFalse(stale.committed);
    assert.isEmpty(stale.storedEvents);
    assert.isFalse(yield* journal.isPending(acceptedId));
    assert.lengthOf(yield* readThreadEvents(threadId), 3);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);
