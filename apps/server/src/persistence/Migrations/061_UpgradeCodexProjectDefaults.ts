import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Move stale GPT-5.4 Codex project defaults to GPT-5.6 Sol at high reasoning.
 * Thread selections are historical state and remain unchanged.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json_set(
      default_model_selection_json,
      '$.model',
      'gpt-5.6-sol',
      '$.options',
      json((
        SELECT json_group_array(json(value))
        FROM (
          SELECT value
          FROM json_each(json_extract(default_model_selection_json, '$.options'))
          WHERE json_extract(value, '$.id') != 'reasoningEffort'
          UNION ALL
          SELECT json_object('id', 'reasoningEffort', 'value', 'high')
        )
      ))
    )
    WHERE coalesce(
      json_extract(default_model_selection_json, '$.instanceId'),
      json_extract(default_model_selection_json, '$.provider')
    ) = 'codex'
      AND json_extract(default_model_selection_json, '$.model') = 'gpt-5.4'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModelSelection.model',
      'gpt-5.6-sol',
      '$.defaultModelSelection.options',
      json((
        SELECT json_group_array(json(value))
        FROM (
          SELECT value
          FROM json_each(json_extract(payload_json, '$.defaultModelSelection.options'))
          WHERE json_extract(value, '$.id') != 'reasoningEffort'
          UNION ALL
          SELECT json_object('id', 'reasoningEffort', 'value', 'high')
        )
      ))
    )
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND coalesce(
        json_extract(payload_json, '$.defaultModelSelection.instanceId'),
        json_extract(payload_json, '$.defaultModelSelection.provider')
      ) = 'codex'
      AND json_extract(payload_json, '$.defaultModelSelection.model') = 'gpt-5.4'
  `;
});
