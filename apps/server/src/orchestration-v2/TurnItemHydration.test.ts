import {
  NodeId,
  OrchestrationV2TurnItemJson,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import { hydrateNativeTurnItems } from "./TurnItemHydration.ts";

const NOW = DateTime.makeUnsafe("2026-09-07T00:00:00.000Z");
const THREAD = ThreadId.make("thread-native-history");
const OTHER_THREAD = ThreadId.make("thread-other");
const TURN = ProviderTurnId.make("provider-turn-1");
const OTHER_TURN = ProviderTurnId.make("provider-turn-2");
const encodeTurnItem = Schema.encodeSync(OrchestrationV2TurnItemJson);

function commandItem(
  id: string,
  threadId: ThreadId,
  providerTurnId: ProviderTurnId | null,
  output: string,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    type: "command_execution",
    threadId,
    runId: null,
    nodeId: NodeId.make("node-native-history"),
    providerThreadId: null,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Command",
    input: "cat large-output.txt",
    output,
    exitCode: 0,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  };
}

it.effect("reads requested native items through the provider-turn index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE orchestration_v2_projection_turn_items (
        turn_item_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider_turn_id TEXT,
        ordinal INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX orchestration_v2_projection_turn_items_provider_turn_idx
      ON orchestration_v2_projection_turn_items(provider_turn_id)
    `;

    const largeOutput = "x".repeat(100_000);
    const requested = commandItem("item-native-history", THREAD, TURN, largeOutput);
    const imported = commandItem("item-imported", THREAD, null, largeOutput);
    const unrelated = commandItem("item-unrelated", THREAD, OTHER_TURN, "unrelated");
    const sameTurnOtherThread = commandItem(
      "item-other-thread",
      OTHER_THREAD,
      TURN,
      "other thread",
    );
    yield* Effect.forEach(
      [requested, imported, unrelated, sameTurnOtherThread],
      (item) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, provider_turn_id, ordinal, payload_json
        ) VALUES (
          ${item.id}, ${item.threadId}, ${item.providerTurnId}, ${item.ordinal},
          ${JSON.stringify(encodeTurnItem(item))}
        )
      `,
    );
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, provider_turn_id, ordinal, payload_json
      ) VALUES (
        ${"item-malformed-unrelated"}, ${THREAD}, ${OTHER_TURN}, ${2}, ${"{"}
      )
    `;

    const result = yield* hydrateNativeTurnItems({ threadId: THREAD, turnIds: [TURN] });
    assert.deepEqual(result, { threadId: THREAD, items: [requested] });
    assert.equal(result.items[0]?.type, "command_execution");
    if (result.items[0]?.type === "command_execution") {
      assert.equal(result.items[0].output, largeOutput);
    }

    const exact = yield* hydrateNativeTurnItems({
      threadId: THREAD,
      itemIds: [imported.id, sameTurnOtherThread.id],
    });
    assert.deepEqual(exact, { threadId: THREAD, items: [imported] });

    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${THREAD}
        AND ${sql.in("provider_turn_id", [TURN])}
      ORDER BY ordinal ASC, turn_item_id ASC
    `;
    assert.isTrue(
      plan.some((row) =>
        row.detail.includes("orchestration_v2_projection_turn_items_provider_turn_idx"),
      ),
    );
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);

it.effect("returns no rows for an empty turn selection", () =>
  hydrateNativeTurnItems({ threadId: THREAD, turnIds: [] }).pipe(
    Effect.map((result) => assert.deepEqual(result, { threadId: THREAD, items: [] })),
    Effect.provide(SqliteClient.layerMemory()),
  ),
);
