import * as DateTime from "effect/DateTime";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProviderEventJournal,
  ProviderEventJournalLive,
  type ProviderEventJournalInput,
} from "./ProviderEventJournal.ts";
import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

const layer = it.layer(ProviderEventJournalLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = ProviderSessionId.make("session:journal");
const replacementProviderSessionId = ProviderSessionId.make("session:journal-replacement");
const threadId = ThreadId.make("thread:journal");
const projectId = ProjectId.make("project:journal");
const providerThreadId = ProviderThreadId.make("provider-thread:journal");
const providerTurnId = ProviderTurnId.make("provider-turn:journal");
const runId = RunId.make("run:journal");
const nodeId = NodeId.make("node:journal");
const now = DateTime.makeUnsafe("2026-09-07T00:00:00.000Z");

const appThread = {
  id: threadId,
  projectId,
  title: "Journal thread",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: providerThreadId,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
} satisfies OrchestrationV2AppThread;

const providerThread = {
  id: providerThreadId,
  driver,
  providerInstanceId,
  providerSessionId,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
} satisfies OrchestrationV2ProviderThread;

const providerTurn = {
  id: providerTurnId,
  providerThreadId,
  nodeId,
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "running",
  startedAt: now,
  completedAt: null,
} satisfies OrchestrationV2ProviderTurn;

const node = {
  id: nodeId,
  threadId,
  runId,
  parentNodeId: null,
  rootNodeId: nodeId,
  kind: "root_turn",
  status: "running",
  countsForRun: true,
  providerThreadId,
  providerTurnId,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: now,
  completedAt: null,
} satisfies OrchestrationV2ExecutionNode;

const subagent = {
  id: NodeId.make("node:journal-subagent"),
  threadId,
  runId,
  parentNodeId: nodeId,
  origin: "app_owned",
  createdBy: "system",
  driver,
  providerInstanceId,
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: null,
  prompt: "journal",
  title: null,
  model: null,
  status: "running",
  result: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
} satisfies OrchestrationV2Subagent;

const message = {
  id: MessageId.make("message:journal"),
  threadId,
  runId,
  nodeId,
  role: "assistant",
  text: "  journal\n\n",
  attachments: [],
  streaming: false,
  createdBy: "agent",
  creationSource: "provider",
  createdAt: now,
  updatedAt: now,
} satisfies OrchestrationV2ConversationMessage;

const turnItem = {
  id: TurnItemId.make("turn-item:journal"),
  threadId,
  runId,
  nodeId,
  providerThreadId,
  providerTurnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  type: "reasoning",
  status: "running",
  title: null,
  text: "journal",
  streaming: false,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
} satisfies OrchestrationV2TurnItem;

const runtimeRequest = {
  id: RuntimeRequestId.make("request:journal"),
  nodeId,
  providerTurnId,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "live", providerSessionId },
  createdAt: now,
  resolvedAt: null,
} satisfies OrchestrationV2RuntimeRequest;

const plan = {
  id: PlanId.make("plan:journal"),
  threadId,
  runId,
  nodeId,
  kind: "proposed_plan",
  status: "active",
  markdown: "journal",
} satisfies OrchestrationV2PlanArtifact;

function input(
  event: ProviderAdapterV2Event,
  sessionId: ProviderSessionId = providerSessionId,
): ProviderEventJournalInput {
  return { providerSessionId: sessionId, providerInstanceId, threadId, event };
}

const event = (event: ProviderAdapterV2Event): ProviderAdapterV2Event => event;

layer("ProviderEventJournal", (it) => {
  it.effect("accepts semantic snapshots durably and deduplicates exact retries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      const snapshot = event({ type: "message.updated", driver, message });

      assert.isTrue(yield* journal.accept(input(snapshot)));
      assert.isFalse(yield* journal.accept(input(snapshot)));
      const accepted = journal.getAccepted(snapshot);
      assert.isDefined(accepted);
      assert.equal(yield* journal.latestSequence, 1);
      assert.deepEqual(yield* journal.readPending({ throughSequence: 1 }), [
        { ...accepted, event: snapshot },
      ]);
    }),
  );

  it.effect("persists and decodes every semantic event family", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      const events = [
        event({ type: "app_thread.created", driver, appThread }),
        event({ type: "provider_thread.updated", driver, providerThread }),
        event({ type: "provider_turn.updated", driver, providerTurn }),
        event({ type: "node.updated", driver, node }),
        event({ type: "subagent.updated", driver, subagent }),
        event({
          type: "message.updated",
          driver,
          message: { ...message, id: MessageId.make("message:journal-family") },
        }),
        event({
          type: "turn_item.updated",
          driver,
          turnItem: { ...turnItem, id: TurnItemId.make("turn-item:journal-family") },
        }),
        event({ type: "runtime_request.updated", driver, runtimeRequest }),
        event({ type: "plan.updated", driver, plan }),
      ];
      for (const current of events) assert.isTrue(yield* journal.accept(input(current)));
      assert.lengthOf(yield* journal.readPending({ throughSequence: 100 }), events.length);
    }),
  );

  it.effect("skips non-snapshot gates without consuming a journal sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      assert.isTrue(
        yield* journal.accept(
          input({
            type: "provider_session.updated",
            driver,
            providerSession: {},
          } as ProviderAdapterV2Event),
        ),
      );
      assert.isTrue(
        yield* journal.accept(input({ type: "turn.terminal", driver } as ProviderAdapterV2Event)),
      );
      assert.equal(yield* journal.latestSequence, 0);
    }),
  );

  it.effect("retires older snapshots for the entity when the latest is committed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      const first = event({ type: "message.updated", driver, message });
      const second = event({
        type: "message.updated",
        driver,
        message: { ...message, text: "newer" },
      });
      assert.isTrue(yield* journal.accept(input(first)));
      assert.isTrue(yield* journal.accept(input(second)));
      const latest = journal.getAccepted(second);
      assert.isDefined(latest);
      assert.isTrue(yield* journal.isPending(latest.id));
      yield* journal.commitAccepted(latest.id);
      assert.isFalse(yield* journal.isPending(latest.id));
      assert.isFalse(yield* journal.isPending(journal.getAccepted(first)!.id));
      assert.lengthOf(yield* journal.readPending({ throughSequence: 100 }), 0);
    }),
  );

  it.effect("retires pending snapshots from a replaced provider session", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      const oldSessionPartial = event({
        type: "message.updated",
        driver,
        message: { ...message, text: "old session partial", streaming: true },
      });
      const replacementFinal = event({
        type: "message.updated",
        driver,
        message: { ...message, text: "replacement final", streaming: false },
      });

      assert.isTrue(yield* journal.accept(input(oldSessionPartial)));
      assert.isTrue(yield* journal.accept(input(replacementFinal, replacementProviderSessionId)));
      const acceptedFinal = journal.getAccepted(replacementFinal);
      assert.isDefined(acceptedFinal);
      yield* journal.commitAccepted(acceptedFinal!.id);

      assert.isFalse(yield* journal.isPending(journal.getAccepted(oldSessionPartial)!.id));
      assert.isEmpty(yield* journal.readPending({ throughSequence: 100 }));
    }),
  );

  it.effect("retains identity tombstones across a fresh pending read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      const snapshot = event({ type: "plan.updated", driver, plan });
      assert.isTrue(yield* journal.accept(input(snapshot)));
      const accepted = journal.getAccepted(snapshot);
      assert.isDefined(accepted);
      yield* journal.commitAccepted(accepted.id);
      assert.isFalse(yield* journal.isPending(accepted.id));
      assert.equal(yield* journal.latestSequence, accepted.sequence);
      const rows = yield* sql`
        SELECT event_json, terminal
        FROM provider_event_journal
        WHERE id = ${accepted.id}
      `;
      assert.isNull(rows[0]?.event_json);
      assert.equal(rows[0]?.terminal, 0);
    }),
  );

  it.effect("rejects late partial snapshots after message and turn-item completion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      const completedMessage = event({ type: "message.updated", driver, message });
      assert.isTrue(yield* journal.accept(input(completedMessage)));
      const acceptedMessage = journal.getAccepted(completedMessage);
      assert.isDefined(acceptedMessage);
      yield* journal.commitAccepted(acceptedMessage!.id);
      const tombstone = yield* sql`
        SELECT event_json, terminal
        FROM provider_event_journal
        WHERE id = ${acceptedMessage!.id}
      `;
      assert.isNull(tombstone[0]?.event_json);
      assert.equal(tombstone[0]?.terminal, 1);
      assert.isFalse(
        yield* journal.accept(
          input({
            type: "message.updated",
            driver,
            message: { ...message, text: "late partial", streaming: true },
          }),
        ),
      );

      const completedTurnItem = event({
        type: "turn_item.updated",
        driver,
        turnItem: { ...turnItem, status: "completed" },
      });
      assert.isTrue(yield* journal.accept(input(completedTurnItem)));
      const acceptedTurnItem = journal.getAccepted(completedTurnItem);
      assert.isDefined(acceptedTurnItem);
      yield* journal.commitAccepted(acceptedTurnItem!.id);
      assert.isFalse(
        yield* journal.accept(
          input({
            type: "turn_item.updated",
            driver,
            turnItem: { ...turnItem, text: "late partial", status: "running" },
          }),
        ),
      );
    }),
  );

  it.effect("rejects a late partial from the old session after replacement finalization", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      const replacementFinal = event({
        type: "message.updated",
        driver,
        message: { ...message, text: "replacement final", streaming: false },
      });
      assert.isTrue(yield* journal.accept(input(replacementFinal, replacementProviderSessionId)));
      const acceptedFinal = journal.getAccepted(replacementFinal);
      assert.isDefined(acceptedFinal);
      yield* journal.commitAccepted(acceptedFinal!.id);

      const lateOldSessionPartial = event({
        type: "message.updated",
        driver,
        message: { ...message, text: "old session late partial", streaming: true },
      });
      assert.isFalse(yield* journal.accept(input(lateOldSessionPartial)));
    }),
  );

  it.effect("allows terminal enrichment and the same entity id in a fresh run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_event_journal`;
      const journal = yield* ProviderEventJournal;
      const first = event({ type: "message.updated", driver, message });
      assert.isTrue(yield* journal.accept(input(first)));
      const firstAccepted = journal.getAccepted(first);
      assert.isDefined(firstAccepted);
      yield* journal.commitAccepted(firstAccepted!.id);

      const enrichment = event({
        type: "message.updated",
        driver,
        message: { ...message, text: "full final output" },
      });
      assert.isTrue(yield* journal.accept(input(enrichment)));

      const freshRun = event({
        type: "message.updated",
        driver,
        message: { ...message, runId: RunId.make("run:journal-fresh"), streaming: true },
      });
      assert.isTrue(yield* journal.accept(input(freshRun)));
    }),
  );

  it.effect("creates the migration table with durable identity columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_event_journal'
      `;
      assert.lengthOf(rows, 1);
      const columns = yield* sql`PRAGMA table_info(provider_event_journal)`;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["sequence", "id", "context_json", "entity_key", "terminal", "event_json", "delivered_at"],
      );
    }),
  );
});
