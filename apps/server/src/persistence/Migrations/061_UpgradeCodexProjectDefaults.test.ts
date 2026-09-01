import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_UpgradeCodexProjectDefaults", (it) => {
  it.effect("upgrades stale Codex project defaults without changing explicit current choices", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at
        )
        VALUES
          (
            'project-stale',
            'Stale Codex',
            '/tmp/stale',
            '{"instanceId":"codex","model":"gpt-5.4","options":[{"id":"serviceTier","value":"fast"},{"id":"reasoningEffort","value":"medium"}]}',
            '[]',
            '2026-09-01T00:00:00.000Z',
            '2026-09-01T00:00:00.000Z'
          ),
          (
            'project-legacy',
            'Legacy Codex',
            '/tmp/legacy',
            '{"provider":"codex","model":"gpt-5.4"}',
            '[]',
            '2026-09-01T00:00:00.000Z',
            '2026-09-01T00:00:00.000Z'
          ),
          (
            'project-current',
            'Current Codex',
            '/tmp/current',
            '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"medium"}]}',
            '[]',
            '2026-09-01T00:00:00.000Z',
            '2026-09-01T00:00:00.000Z'
          ),
          (
            'project-other-provider',
            'Other Provider',
            '/tmp/other',
            '{"instanceId":"cursor","model":"gpt-5.4"}',
            '[]',
            '2026-09-01T00:00:00.000Z',
            '2026-09-01T00:00:00.000Z'
          )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-stale',
            'project',
            'project-stale',
            1,
            'project.created',
            '2026-09-01T00:00:00.000Z',
            'user',
            '{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4","options":[{"id":"serviceTier","value":"fast"}]}}',
            '{}'
          ),
          (
            'event-current',
            'project',
            'project-current',
            1,
            'project.meta-updated',
            '2026-09-01T00:00:00.000Z',
            'user',
            '{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"medium"}]}}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 61 });

      const projects = yield* sql<{
        readonly projectId: string;
        readonly selection: string;
      }>`
        SELECT
          project_id AS "projectId",
          default_model_selection_json AS selection
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(
        projects.map(({ projectId, selection }) => ({
          projectId,
          selection: JSON.parse(selection),
        })),
        [
          {
            projectId: "project-current",
            selection: {
              instanceId: "codex",
              model: "gpt-5.6-sol",
              options: [{ id: "reasoningEffort", value: "medium" }],
            },
          },
          {
            projectId: "project-legacy",
            selection: {
              provider: "codex",
              model: "gpt-5.6-sol",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          },
          {
            projectId: "project-other-provider",
            selection: { instanceId: "cursor", model: "gpt-5.4" },
          },
          {
            projectId: "project-stale",
            selection: {
              instanceId: "codex",
              model: "gpt-5.6-sol",
              options: [
                { id: "serviceTier", value: "fast" },
                { id: "reasoningEffort", value: "high" },
              ],
            },
          },
        ],
      );

      const events = yield* sql<{
        readonly eventId: string;
        readonly payload: string;
      }>`
        SELECT event_id AS "eventId", payload_json AS payload
        FROM orchestration_events
        ORDER BY event_id
      `;
      assert.deepStrictEqual(
        events.map(({ eventId, payload }) => ({ eventId, payload: JSON.parse(payload) })),
        [
          {
            eventId: "event-current",
            payload: {
              defaultModelSelection: {
                instanceId: "codex",
                model: "gpt-5.6-sol",
                options: [{ id: "reasoningEffort", value: "medium" }],
              },
            },
          },
          {
            eventId: "event-stale",
            payload: {
              defaultModelSelection: {
                instanceId: "codex",
                model: "gpt-5.6-sol",
                options: [
                  { id: "serviceTier", value: "fast" },
                  { id: "reasoningEffort", value: "high" },
                ],
              },
            },
          },
        ],
      );
    }),
  );
});
