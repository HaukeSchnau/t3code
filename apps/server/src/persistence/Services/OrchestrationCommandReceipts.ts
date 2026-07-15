/**
 * OrchestrationCommandReceiptRepository - Repository interface for command receipts.
 *
 * Owns persistence operations for deduplication and status tracking of
 * orchestration command handling.
 *
 * @module OrchestrationCommandReceiptRepository
 */
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationCommandReceiptStatus,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, ProviderInstanceId]),
  commandVariant: Schema.NullOr(Schema.String),
  envelopeFingerprint: Schema.NullOr(Schema.String),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: OrchestrationCommandReceiptStatus,
  error: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

const newReceiptIdentityFields = {
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, ProviderInstanceId]),
  commandVariant: Schema.String,
  envelopeFingerprint: Schema.String,
} as const;

export const ClaimAcceptedReceiptInput = Schema.Struct({
  ...newReceiptIdentityFields,
  acceptedAt: IsoDateTime,
});
export type ClaimAcceptedReceiptInput = typeof ClaimAcceptedReceiptInput.Type;

export const FinalizeAcceptedReceiptInput = Schema.Struct({
  commandId: CommandId,
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
});
export type FinalizeAcceptedReceiptInput = typeof FinalizeAcceptedReceiptInput.Type;

export const InsertRejectedReceiptInput = Schema.Struct({
  ...newReceiptIdentityFields,
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  error: Schema.String,
});
export type InsertRejectedReceiptInput = typeof InsertRejectedReceiptInput.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

/**
 * OrchestrationCommandReceiptRepositoryShape - Service API for command receipts.
 */
export interface OrchestrationCommandReceiptRepositoryShape {
  /**
   * Claim an accepted command id as the first write in the event transaction.
   * The provisional row must be finalized before that transaction commits.
   */
  readonly claimAccepted: (
    input: ClaimAcceptedReceiptInput,
  ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

  /** Finalize a provisional accepted claim using compare-and-set semantics. */
  readonly finalizeAccepted: (
    input: FinalizeAcceptedReceiptInput,
  ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

  /** Insert an immutable terminal rejection. */
  readonly insertRejected: (
    input: InsertRejectedReceiptInput,
  ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

  /**
   * Read a command receipt by command id.
   */
  readonly getByCommandId: (
    input: GetByCommandIdInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationCommandReceipt>,
    OrchestrationCommandReceiptRepositoryError
  >;
}

/**
 * OrchestrationCommandReceiptRepository - Service tag for command receipt persistence.
 */
export class OrchestrationCommandReceiptRepository extends Context.Service<
  OrchestrationCommandReceiptRepository,
  OrchestrationCommandReceiptRepositoryShape
>()("t3/persistence/Services/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}
