import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ClaimAcceptedReceiptInput,
  FinalizeAcceptedReceiptInput,
  GetByCommandIdInput,
  InsertRejectedReceiptInput,
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../Services/OrchestrationCommandReceipts.ts";

const ReceiptWriteResult = Schema.Struct({ commandId: CommandId });

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const claimAcceptedReceiptRow = SqlSchema.findOneOption({
    Request: ClaimAcceptedReceiptInput,
    Result: ReceiptWriteResult,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
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
          ${receipt.commandVariant},
          ${receipt.envelopeFingerprint},
          ${receipt.acceptedAt},
          0,
          'accepted',
          NULL
        )
        ON CONFLICT (command_id) DO NOTHING
        RETURNING command_id AS "commandId"
      `,
  });

  const finalizeAcceptedReceiptRow = SqlSchema.findOneOption({
    Request: FinalizeAcceptedReceiptInput,
    Result: ReceiptWriteResult,
    execute: (receipt) =>
      sql`
        UPDATE orchestration_command_receipts
        SET
          accepted_at = ${receipt.acceptedAt},
          result_sequence = ${receipt.resultSequence}
        WHERE command_id = ${receipt.commandId}
          AND status = 'accepted'
          AND result_sequence = 0
        RETURNING command_id AS "commandId"
      `,
  });

  const insertRejectedReceiptRow = SqlSchema.findOneOption({
    Request: InsertRejectedReceiptInput,
    Result: ReceiptWriteResult,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
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
          ${receipt.commandVariant},
          ${receipt.envelopeFingerprint},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          'rejected',
          ${receipt.error}
        )
        ON CONFLICT (command_id) DO NOTHING
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

  const claimAccepted: OrchestrationCommandReceiptRepositoryShape["claimAccepted"] = (input) =>
    claimAcceptedReceiptRow(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.claimAccepted:query"),
      ),
    );

  const finalizeAccepted: OrchestrationCommandReceiptRepositoryShape["finalizeAccepted"] = (
    input,
  ) =>
    finalizeAcceptedReceiptRow(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.finalizeAccepted:query"),
      ),
    );

  const insertRejected: OrchestrationCommandReceiptRepositoryShape["insertRejected"] = (input) =>
    insertRejectedReceiptRow(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.insertRejected:query"),
      ),
    );

  const getByCommandId: OrchestrationCommandReceiptRepositoryShape["getByCommandId"] = (input) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  return {
    claimAccepted,
    finalizeAccepted,
    insertRejected,
    getByCommandId,
  } satisfies OrchestrationCommandReceiptRepositoryShape;
});

export const OrchestrationCommandReceiptRepositoryLive = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
