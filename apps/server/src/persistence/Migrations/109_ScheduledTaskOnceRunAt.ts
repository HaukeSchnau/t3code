import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork builds stored one-time schedules as {type:"once", at}; upstream's schema names the field runAt.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE scheduled_tasks
    SET schedule_json = json_object('type', 'once', 'runAt', json_extract(schedule_json, '$.at'))
    WHERE json_valid(schedule_json)
      AND json_extract(schedule_json, '$.type') = 'once'
      AND json_type(schedule_json, '$.at') = 'text'
      AND json_type(schedule_json, '$.runAt') IS NULL
  `;
});
