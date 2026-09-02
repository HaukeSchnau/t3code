/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationAggregateKind,
  OrchestrationClientOrigin,
  OrchestrationCommand,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import type { OrchestrationReplayProbe } from "../../persistence/Services/OrchestrationEventStore.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to read. Defaults to the event
   *   store's page-bounded default; pass a higher value when the caller must
   *   read every global event after the cursor.
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Replay one aggregate without scanning unrelated global events. */
  readonly readAggregateEvents?: (
    aggregateKind: OrchestrationAggregateKind,
    aggregateId: ProjectId | ThreadId | ProviderInstanceId,
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Explicit capability for payload-free replay planning. Consumers must test
   * for this own property rather than probing optional service methods: Effect
   * test mocks intentionally synthesize failures for unimplemented methods.
   */
  readonly replayProbeCapability?: OrchestrationReplayProbeCapability;

  /** Explicit scoped live subscription acquisition for lossless catch-up. */
  readonly liveSubscriptionCapability?: OrchestrationLiveSubscriptionCapability;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @param options - Optional client origin (surface/app version) stamped into
   *   the metadata of every event the command produces.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    options?: { readonly origin?: OrchestrationClientOrigin },
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Validate a command against an existing immutable receipt without executing it.
   * None means the command id has not yet reached the durable receipt boundary.
   */
  readonly resolveReceipt: (
    command: OrchestrationCommand,
  ) => Effect.Effect<
    Option.Option<{ readonly sequence: number }>,
    OrchestrationDispatchError,
    never
  >;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /** Acquire a live domain-event subscription before starting a consumer. */
  readonly subscribeDomainEvents?: Effect.Effect<
    Stream.Stream<OrchestrationEvent>,
    never,
    Scope.Scope
  >;

  /**
   * The latest sequence reflected in the engine's authoritative command read
   * model (0 if none). Used to gauge how far behind a resuming client is before
   * choosing between an incremental replay and a fresh projected snapshot.
   */
  readonly latestSequence: Effect.Effect<number, never, never>;
}

export interface OrchestrationReplayProbeCapability {
  readonly kind: "payload-free-v1";
  readonly probeReplay: (
    fromSequenceExclusive: number,
    maxEvents: number,
  ) => Effect.Effect<OrchestrationReplayProbe, OrchestrationEventStoreError>;
  readonly probeAggregateReplay: (
    aggregateKind: OrchestrationAggregateKind,
    aggregateId: ProjectId | ThreadId | ProviderInstanceId,
    fromSequenceExclusive: number,
    maxEvents: number,
  ) => Effect.Effect<OrchestrationReplayProbe, OrchestrationEventStoreError>;
}

export interface OrchestrationLiveSubscriptionCapability {
  readonly kind: "scoped-v1";
  readonly subscribe: Effect.Effect<Stream.Stream<OrchestrationEvent>, never, Scope.Scope>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
