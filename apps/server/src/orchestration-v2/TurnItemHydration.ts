import {
  OrchestrationV2GetTurnItemsError,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2GetTurnItemsInput,
  type OrchestrationV2GetTurnItemsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type NativeTurnItemsInput = OrchestrationV2GetTurnItemsInput;

type TurnItemPayloadRow = {
  readonly payload_json: string;
};

const decodeNativeTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const isGetTurnItemsError = Schema.is(OrchestrationV2GetTurnItemsError);

function getTurnItemsError(threadId: NativeTurnItemsInput["threadId"], cause: unknown) {
  return new OrchestrationV2GetTurnItemsError({
    threadId,
    message: `Failed to load native turn items for thread ${threadId}`,
    cause,
  });
}

/**
 * Reads only the requested native turn items from the projection table. The
 * primary key or provider-turn index bounds the lookup, and the native JSON schema preserves
 * full detail without applying the transport truncation projection.
 */
export function hydrateNativeTurnItems(
  input: NativeTurnItemsInput,
): Effect.Effect<
  OrchestrationV2GetTurnItemsResult,
  OrchestrationV2GetTurnItemsError,
  SqlClient.SqlClient
> {
  if ((input.itemIds ?? input.turnIds ?? []).length === 0) {
    return Effect.succeed({ threadId: input.threadId, items: [] });
  }

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const selection =
      input.itemIds === undefined
        ? sql.in("provider_turn_id", input.turnIds ?? [])
        : sql.in("turn_item_id", input.itemIds);
    const rows = yield* sql<TurnItemPayloadRow>`
      SELECT payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId}
        AND ${selection}
      ORDER BY ordinal ASC, turn_item_id ASC
    `;
    const items = yield* Effect.forEach(rows, (row) =>
      decodeNativeTurnItem(row.payload_json).pipe(
        Effect.mapError((cause) => getTurnItemsError(input.threadId, cause)),
      ),
    );
    return { threadId: input.threadId, items };
  }).pipe(
    Effect.mapError((cause) =>
      isGetTurnItemsError(cause) ? cause : getTurnItemsError(input.threadId, cause),
    ),
  );
}
