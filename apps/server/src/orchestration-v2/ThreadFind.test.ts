import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadFind from "./ThreadFind.ts";

const TestLayer = Layer.mergeAll(ThreadFind.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:find");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 8, 12, 0));

const threadCreated = (threadId: ThreadId): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
});

const base = (threadId: ThreadId, id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

const itemUpdated = (item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
  id: EventId.make(`item:${item.id}`),
  type: "turn-item.updated",
  threadId: item.threadId,
  occurredAt: at,
  payload: item,
});

const seedThread = (threadId: ThreadId, items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply(threadCreated(threadId));
    for (const item of items) yield* projections.apply(itemUpdated(item));
  });

it.layer(TestLayer)("ThreadFind", (it) => {
  it.effect("finds visible text and server-only detail in timeline order", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:find-order");
      yield* seedThread(threadId, [
        {
          ...base(threadId, "item:user", 1),
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message:user"),
          inputIntent: "turn_start",
          text: "Why does the **probe** time out?",
          attachments: [],
        },
        {
          ...base(threadId, "item:command", 2),
          type: "command_execution",
          input: "vp test run probe.test.ts",
          output: "ok\nTimeoutError: probe exceeded 1500ms\nprobe retried",
        },
        {
          ...base(threadId, "item:answer", 3),
          type: "assistant_message",
          messageId: MessageId.make("message:answer"),
          text: "The `probe` waits for a pong.",
          streaming: false,
        },
      ]);

      const find = yield* ThreadFind.ThreadFind;
      const result = yield* find.find({ threadId, query: "probe" });

      assert.isFalse(result.truncated);
      assert.deepStrictEqual(
        result.matches.map((match) => [
          match.sourceItemId,
          match.position,
          match.source,
          match.field,
          match.occurrence,
        ]),
        [
          ["item:user", 0, "user", "text", 0],
          ["item:command", 1, "tool", "text", 0],
          ["item:command", 1, "tool", "detail", 0],
          ["item:command", 1, "tool", "detail", 1],
          ["item:answer", 2, "assistant", "text", 0],
        ],
      );
      // Markdown is matched as rendered, so the excerpt has no emphasis markers.
      assert.strictEqual(result.matches[0]!.excerpt.text, "Why does the probe time out?");
      const detail = result.matches[2]!.excerpt;
      assert.strictEqual(detail.text, "ok\nTimeoutError: probe exceeded 1500ms\nprobe retried");
      assert.strictEqual(detail.line, 2);
      assert.strictEqual(detail.text.slice(detail.start, detail.end), "probe");
    }),
  );

  it.effect("searches only the start of long output and says how long it was", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:find-long");
      const output = `needle at the start\n${"x".repeat(300 * 1024)}\nneedle past the cap`;
      yield* seedThread(threadId, [
        {
          ...base(threadId, "item:long", 1),
          type: "command_execution",
          input: "cat big.log",
          output,
        },
      ]);

      const find = yield* ThreadFind.ThreadFind;
      const result = yield* find.find({ threadId, query: "needle" });

      assert.strictEqual(result.matches.length, 1);
      assert.strictEqual(result.matches[0]!.excerpt.totalLength, output.length);
    }),
  );

  it.effect("stops at the match limit", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:find-limit");
      yield* seedThread(threadId, [
        {
          ...base(threadId, "item:many", 1),
          type: "command_execution",
          input: "yes ab | head -n 1500",
          output: "ab\n".repeat(1500),
        },
      ]);

      const find = yield* ThreadFind.ThreadFind;
      const result = yield* find.find({ threadId, query: "ab" });

      assert.isTrue(result.truncated);
      assert.strictEqual(result.matches.length, 1000);
    }),
  );

  it.effect("finds nothing for an invalid regex and fails for an unknown thread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:find-invalid");
      yield* seedThread(threadId, []);
      const find = yield* ThreadFind.ThreadFind;

      const invalid = yield* find.find({ threadId, query: "probe(", regex: true });
      assert.deepStrictEqual(invalid, { matches: [], truncated: false });

      const missing = yield* Effect.flip(
        find.find({ threadId: ThreadId.make("thread:missing"), query: "probe" }),
      );
      assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
    }),
  );
});
