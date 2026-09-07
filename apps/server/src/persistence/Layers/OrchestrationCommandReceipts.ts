import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PersistenceSqlError, toPersistenceSqlError } from "../Errors.ts";

import {
  GetByCommandIdInput,
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../Services/OrchestrationCommandReceipts.ts";

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.findOneOption({
    Request: OrchestrationCommandReceipt,
    Result: Schema.Struct({ commandId: Schema.String }),
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          command_type,
          command_variant,
          envelope_fingerprint,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.commandType},
          ${receipt.commandVariant ?? null},
          ${receipt.envelopeFingerprint ?? null},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
          aggregate_id = excluded.aggregate_id,
          command_type = excluded.command_type,
          command_variant = excluded.command_variant,
          envelope_fingerprint = excluded.envelope_fingerprint,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error
        WHERE orchestration_command_receipts.status = 'accepted'
          AND orchestration_command_receipts.result_sequence = 0
          AND orchestration_command_receipts.aggregate_kind = excluded.aggregate_kind
          AND orchestration_command_receipts.aggregate_id = excluded.aggregate_id
          AND orchestration_command_receipts.command_type = excluded.command_type
          AND orchestration_command_receipts.command_variant IS excluded.command_variant
          AND orchestration_command_receipts.envelope_fingerprint IS excluded.envelope_fingerprint
        RETURNING command_id AS "commandId"
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          command_type AS "commandType",
          command_variant AS "commandVariant",
          envelope_fingerprint AS "envelopeFingerprint",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  });

  const upsert: OrchestrationCommandReceiptRepositoryShape["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new PersistenceSqlError({
                operation: "OrchestrationCommandReceiptRepository.upsert:conflict",
                detail: "Command receipt identity was already claimed by a different envelope.",
              }),
            ),
          onSome: () => Effect.void,
        }),
      ),
    );

  const insertIfAbsent: OrchestrationCommandReceiptRepositoryShape["insertIfAbsent"] = (receipt) =>
    sql<{ readonly command_id: string }>`
      INSERT INTO orchestration_command_receipts (
        command_id,
        aggregate_kind,
        aggregate_id,
        command_type,
        command_variant,
        envelope_fingerprint,
        accepted_at,
        result_sequence,
        status,
        error
      )
      VALUES (
        ${receipt.commandId},
        ${receipt.aggregateKind},
        ${receipt.aggregateId},
        ${receipt.commandType},
        ${receipt.commandVariant ?? null},
        ${receipt.envelopeFingerprint ?? null},
        ${receipt.acceptedAt},
        ${receipt.resultSequence},
        ${receipt.status},
        ${receipt.error}
      )
      ON CONFLICT(command_id) DO NOTHING
      RETURNING command_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.insertIfAbsent:query"),
      ),
    );

  const getByCommandId: OrchestrationCommandReceiptRepositoryShape["getByCommandId"] = (input) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  return {
    insertIfAbsent,
    upsert,
    getByCommandId,
  } satisfies OrchestrationCommandReceiptRepositoryShape;
});

export const OrchestrationCommandReceiptRepositoryLive = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
