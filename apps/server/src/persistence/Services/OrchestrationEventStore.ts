/**
 * OrchestrationEventStore - Event store interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import type {
  OrchestrationAggregateKind,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../Errors.ts";

export interface OrchestrationReplayProbe {
  /** Number of lightweight rows inspected, capped at `maxEvents + 1`. */
  readonly eventCount: number;
  /** Encoded payload and metadata bytes represented by the inspected rows. */
  readonly payloadBytes: number;
  /** Whether at least one event exists beyond the requested event bound. */
  readonly truncated: boolean;
}

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Replay one aggregate stream without decoding unrelated global events. */
  readonly readAggregateFromSequence?: (
    aggregateKind: OrchestrationAggregateKind,
    aggregateId: ProjectId | ThreadId | ProviderInstanceId,
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Inspect a bounded global replay range without loading or decoding event
   * payloads. The extra sentinel row makes large-backlog detection bounded.
   */
  readonly probeFromSequence?: (
    sequenceExclusive: number,
    maxEvents: number,
  ) => Effect.Effect<OrchestrationReplayProbe, OrchestrationEventStoreError>;

  /** Inspect one aggregate replay range using its indexed sequence path. */
  readonly probeAggregateFromSequence?: (
    aggregateKind: OrchestrationAggregateKind,
    aggregateId: ProjectId | ThreadId | ProviderInstanceId,
    sequenceExclusive: number,
    maxEvents: number,
  ) => Effect.Effect<OrchestrationReplayProbe, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Check whether an aggregate has an event of the given type after a sequence.
   *
   * Used during replay to tell whether a later event supersedes the one being
   * applied, without streaming the rest of the log.
   */
  readonly hasEventAfter: (input: {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: string;
    readonly type: OrchestrationEvent["type"];
    readonly sequenceExclusive: number;
  }) => Effect.Effect<boolean, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("t3/persistence/Services/OrchestrationEventStore") {}
