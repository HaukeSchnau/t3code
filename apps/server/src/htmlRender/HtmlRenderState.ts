import { HtmlRenderState as HtmlRenderStateSchema, type ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class HtmlRenderStateError extends Schema.TaggedError<HtmlRenderStateError>()(
  "HtmlRenderStateError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(HtmlRenderStateSchema));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(HtmlRenderStateSchema));

/** Ownership is the caller's to check; this only stores one map per render. */
export class HtmlRenderState extends Context.Service<
  HtmlRenderState,
  {
    readonly get: (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
    }) => Effect.Effect<HtmlRenderStateSchema, HtmlRenderStateError>;
    /** An empty map removes the render's row. */
    readonly set: (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
      readonly state: HtmlRenderStateSchema;
    }) => Effect.Effect<void, HtmlRenderStateError>;
  }
>()("t3/htmlRender/HtmlRenderState") {}

export const layer = Layer.effect(
  HtmlRenderState,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fail = (cause: unknown) => new HtmlRenderStateError({ cause });

    const get = Effect.fn("HtmlRenderState.get")(function* (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
    }) {
      const rows = yield* sql<{ state_json: string }>`
        SELECT state_json FROM html_render_state
        WHERE thread_id = ${input.threadId} AND render_id = ${input.renderId}
      `.pipe(NodeSqliteClient.readOnly);
      const row = rows[0];
      return row === undefined ? {} : yield* decodeState(row.state_json);
    }, Effect.mapError(fail));

    const set = Effect.fn("HtmlRenderState.set")(function* (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
      readonly state: HtmlRenderStateSchema;
    }) {
      if (Object.keys(input.state).length === 0) {
        yield* sql`
          DELETE FROM html_render_state
          WHERE thread_id = ${input.threadId} AND render_id = ${input.renderId}
        `;
        return;
      }
      const stateJson = yield* encodeState(input.state);
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO html_render_state (thread_id, render_id, state_json, updated_at)
        VALUES (${input.threadId}, ${input.renderId}, ${stateJson}, ${updatedAt})
        ON CONFLICT(thread_id, render_id) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `;
    }, Effect.mapError(fail));

    return HtmlRenderState.of({ get, set });
  }),
);
