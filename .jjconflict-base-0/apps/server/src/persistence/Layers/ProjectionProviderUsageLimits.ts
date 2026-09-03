import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  OrchestrationUsageLimitHistoryWindow,
  OrchestrationUsageLimitsSnapshot,
} from "@t3tools/contracts";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionProviderUsageLimitsInput,
  ProjectionProviderUsageLimits,
  ProjectionProviderUsageLimitsRepository,
  type ProjectionProviderUsageLimitsRepositoryShape,
} from "../Services/ProjectionProviderUsageLimits.ts";
import { appendProviderUsageHistory } from "../ProviderUsageHistory.ts";

const ProjectionProviderUsageLimitsDbRowSchema = ProjectionProviderUsageLimits.mapFields(
  Struct.assign({
    usageLimits: Schema.fromJsonString(OrchestrationUsageLimitsSnapshot),
    history: Schema.fromJsonString(Schema.Array(OrchestrationUsageLimitHistoryWindow)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionProviderUsageLimitsRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionProviderUsageLimitsRow = SqlSchema.void({
    Request: ProjectionProviderUsageLimits,
    execute: (row) =>
      sql`
        INSERT INTO projection_provider_usage_limits (
          provider_instance_id,
          provider,
          usage_limits_json,
          history_json,
          updated_at
        )
        VALUES (
          ${row.providerInstanceId},
          ${row.provider},
          ${JSON.stringify(row.usageLimits)},
          ${JSON.stringify(row.history)},
          ${row.updatedAt}
        )
        ON CONFLICT (provider_instance_id)
        DO UPDATE SET
          provider = excluded.provider,
          usage_limits_json = excluded.usage_limits_json,
          history_json = excluded.history_json,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionProviderUsageLimitsRow = SqlSchema.findOneOption({
    Request: GetProjectionProviderUsageLimitsInput,
    Result: ProjectionProviderUsageLimitsDbRowSchema,
    execute: ({ providerInstanceId }) =>
      sql`
        SELECT
          provider_instance_id AS "providerInstanceId",
          provider,
          usage_limits_json AS "usageLimits",
          history_json AS "history",
          updated_at AS "updatedAt"
        FROM projection_provider_usage_limits
        WHERE provider_instance_id = ${providerInstanceId}
      `,
  });

  const listProjectionProviderUsageLimitsRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProviderUsageLimitsDbRowSchema,
    execute: () =>
      sql`
        SELECT
          provider_instance_id AS "providerInstanceId",
          provider,
          usage_limits_json AS "usageLimits",
          history_json AS "history",
          updated_at AS "updatedAt"
        FROM projection_provider_usage_limits
        ORDER BY updated_at DESC, provider_instance_id ASC
      `,
  });

  const upsert: ProjectionProviderUsageLimitsRepositoryShape["upsert"] = (row) =>
    sql
      .withTransaction(
        getProjectionProviderUsageLimitsRow({ providerInstanceId: row.providerInstanceId }).pipe(
          Effect.flatMap((existing) =>
            upsertProjectionProviderUsageLimitsRow({
              ...row,
              history: appendProviderUsageHistory(
                Option.getOrUndefined(existing)?.history ?? [],
                row.usageLimits,
              ),
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionProviderUsageLimitsRepository.upsert:query",
            "ProjectionProviderUsageLimitsRepository.upsert:encodeRequest",
          ),
        ),
      );

  const getByProviderInstanceId: ProjectionProviderUsageLimitsRepositoryShape["getByProviderInstanceId"] =
    (input) =>
      getProjectionProviderUsageLimitsRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionProviderUsageLimitsRepository.getByProviderInstanceId:query",
            "ProjectionProviderUsageLimitsRepository.getByProviderInstanceId:decodeRow",
          ),
        ),
      );

  const list: ProjectionProviderUsageLimitsRepositoryShape["list"] = () =>
    listProjectionProviderUsageLimitsRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionProviderUsageLimitsRepository.list:query",
          "ProjectionProviderUsageLimitsRepository.list:decodeRows",
        ),
      ),
    );

  return {
    upsert,
    getByProviderInstanceId,
    list,
  } satisfies ProjectionProviderUsageLimitsRepositoryShape;
});

export const ProjectionProviderUsageLimitsRepositoryLive = Layer.effect(
  ProjectionProviderUsageLimitsRepository,
  makeProjectionProviderUsageLimitsRepository,
);
