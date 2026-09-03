/**
 * Crash-durable write-ahead journal for semantic assistant transcript events.
 *
 * Adapters append before their first volatile queue/publication. Ingestion
 * removes an entry only after the corresponding projection command is durable.
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface ProviderTranscriptJournalEntry {
  readonly sequence: number;
  readonly batchId: string | null;
  readonly event: ProviderRuntimeEvent;
}

export interface ProviderTranscriptJournalBatchSeal {
  readonly batchId: string;
  readonly sourceEvents: ReadonlyArray<ProviderRuntimeEvent>;
}

export interface ProviderTranscriptJournalShape {
  readonly append: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly list: Effect.Effect<
    ReadonlyArray<ProviderTranscriptJournalEntry>,
    ProjectionRepositoryError
  >;
  readonly listUndelivered: Effect.Effect<
    ReadonlyArray<ProviderTranscriptJournalEntry>,
    ProjectionRepositoryError
  >;
  readonly sealBatches: (
    batches: ReadonlyArray<ProviderTranscriptJournalBatchSeal>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markDelivered: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markDeliveredMany: (
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly remove: (event: ProviderRuntimeEvent) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeMany: (
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeItem: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly isItemCompleted: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markItemCompleted: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProviderTranscriptJournal extends Context.Service<
  ProviderTranscriptJournal,
  ProviderTranscriptJournalShape
>()("t3/persistence/Services/ProviderTranscriptJournal") {}
