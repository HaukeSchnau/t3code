import type {
  OrchestrationAggregateKind,
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { OrchestrationCommandReceipt } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandReceiptMismatchError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { commandEnvelopeFingerprint } from "../CommandEnvelope.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { incrementWorkloadCounter } from "../../diagnostics/WorkloadDiagnostics.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

const isMissingAggregateInvariant = (error: OrchestrationCommandInvariantError) =>
  error.detail.includes("does not exist for command");

interface CommandEnvelope {
  command: OrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

interface CommandReceiptIdentity {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly aggregateKind: "project" | "thread" | "provider";
  readonly aggregateId: ProjectId | ThreadId | ProviderInstanceId;
  readonly commandVariant: OrchestrationCommand["type"];
  readonly envelopeFingerprint: string;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread" | "provider";
  readonly aggregateId: ProjectId | ThreadId | ProviderInstanceId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    case "provider.usage-limits.update":
      return {
        aggregateKind: "provider",
        aggregateId: command.providerInstanceId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const commandReceiptIdentity = (command: OrchestrationCommand): CommandReceiptIdentity => {
    const aggregateRef = commandToAggregateRef(command);
    return {
      commandId: command.commandId,
      aggregateKind: aggregateRef.aggregateKind,
      aggregateId: aggregateRef.aggregateId,
      commandVariant: command.type,
      envelopeFingerprint: commandEnvelopeFingerprint(command),
    };
  };

  const resolveExistingReceipt = (
    receipt: OrchestrationCommandReceipt,
    receiptIdentity: CommandReceiptIdentity,
  ): Effect.Effect<
    { sequence: number },
    OrchestrationCommandReceiptMismatchError | OrchestrationCommandPreviouslyRejectedError
  > => {
    if (
      receipt.aggregateKind !== receiptIdentity.aggregateKind ||
      receipt.aggregateId !== receiptIdentity.aggregateId
    ) {
      return Effect.fail(
        new OrchestrationCommandReceiptMismatchError({
          commandId: receiptIdentity.commandId,
          reason: "aggregate-mismatch",
          detail: `Receipt belongs to ${receipt.aggregateKind} '${receipt.aggregateId}', not ${receiptIdentity.aggregateKind} '${receiptIdentity.aggregateId}'.`,
        }),
      );
    }
    if (receipt.commandVariant === null || receipt.envelopeFingerprint === null) {
      return Effect.fail(
        new OrchestrationCommandReceiptMismatchError({
          commandId: receiptIdentity.commandId,
          reason: "legacy-unverifiable",
          detail:
            "The durable receipt predates command envelope fingerprints and cannot be replayed safely.",
        }),
      );
    }
    if (receipt.commandVariant !== receiptIdentity.commandVariant) {
      return Effect.fail(
        new OrchestrationCommandReceiptMismatchError({
          commandId: receiptIdentity.commandId,
          reason: "variant-mismatch",
          detail: `Receipt variant '${receipt.commandVariant}' does not match '${receiptIdentity.commandVariant}'.`,
        }),
      );
    }
    if (receipt.envelopeFingerprint !== receiptIdentity.envelopeFingerprint) {
      return Effect.fail(
        new OrchestrationCommandReceiptMismatchError({
          commandId: receiptIdentity.commandId,
          reason: "payload-mismatch",
          detail: "The canonical command envelope differs from the original command.",
        }),
      );
    }
    if (receipt.status === "accepted") {
      return Effect.succeed({ sequence: receipt.resultSequence });
    }
    return Effect.fail(
      new OrchestrationCommandPreviouslyRejectedError({
        commandId: receiptIdentity.commandId,
        detail: receipt.error ?? "Previously rejected.",
      }),
    );
  };

  const resolveReceipt: OrchestrationEngineShape["resolveReceipt"] = (command) => {
    const receiptIdentity = commandReceiptIdentity(command);
    return commandReceiptRepository.getByCommandId({ commandId: command.commandId }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (receipt) =>
            resolveExistingReceipt(receipt, receiptIdentity).pipe(Effect.map(Option.some)),
        }),
      ),
    );
  };

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    let dispatchAttemptedEffects = false;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const receiptIdentity = commandReceiptIdentity(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          return yield* resolveExistingReceipt(existingReceipt.value, receiptIdentity);
        }

        const decide = () =>
          decideOrchestrationCommand({
            command: envelope.command,
            readModel: commandReadModel,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError((cause) =>
              isOrchestrationCommandInvariantError(cause)
                ? cause
                : new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Failed to generate an event identifier.",
                    cause,
                  }),
            ),
          );
        const eventBase = yield* decide().pipe(
          Effect.catchIf(isMissingAggregateInvariant, (initialError) =>
            Effect.gen(function* () {
              commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
              return yield* decide().pipe(
                Effect.mapError((refreshedError) =>
                  isMissingAggregateInvariant(refreshedError) ? initialError : refreshedError,
                ),
              );
            }),
          ),
        );
        const plannedEvents = Array.isArray(eventBase) ? eventBase : [eventBase];
        // Stamp the dispatching client's origin onto every event the command
        // produced. The decider stays pure; attribution is an engine concern.
        const eventBases =
          envelope.origin === undefined
            ? plannedEvents
            : plannedEvents.map((planned) => ({
                ...planned,
                metadata: { ...planned.metadata, origin: envelope.origin },
              }));
        dispatchAttemptedEffects = true;
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const claimed = yield* commandReceiptRepository.claimAccepted({
                ...receiptIdentity,
                acceptedAt: yield* nowIso,
              });
              if (!claimed) {
                const winningReceipt = yield* commandReceiptRepository.getByCommandId({
                  commandId: envelope.command.commandId,
                });
                if (Option.isNone(winningReceipt)) {
                  return yield* new PersistenceSqlError({
                    operation: "OrchestrationEngine.processEnvelope:claim",
                    detail: "Command receipt claim lost without a durable winning receipt.",
                  });
                }
                return {
                  _tag: "replayed" as const,
                  result: yield* resolveExistingReceipt(winningReceipt.value, receiptIdentity),
                };
              }

              const committedEvents: OrchestrationEvent[] = [];
              const attachmentCleanups: Effect.Effect<void>[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                const cleanup = yield* projectionPipeline.projectEventDeferred(savedEvent);
                attachmentCleanups.push(cleanup);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              // Idempotent commands can succeed without changing the event log. Their receipt
              // points at the snapshot they observed so retries replay the same successful no-op.
              const acceptedAt = lastSavedEvent?.occurredAt ?? (yield* nowIso);
              const resultSequence = lastSavedEvent?.sequence ?? commandReadModel.snapshotSequence;

              const finalized = yield* commandReceiptRepository.finalizeAccepted({
                commandId: receiptIdentity.commandId,
                acceptedAt,
                resultSequence,
              });
              if (!finalized) {
                return yield* new PersistenceSqlError({
                  operation: "OrchestrationEngine.processEnvelope:finalizeClaim",
                  detail: "Accepted command receipt claim could not be finalized.",
                });
              }

              return {
                _tag: "accepted" as const,
                committedEvents,
                attachmentCleanups,
                lastSequence: resultSequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        if (committedCommand._tag === "replayed") {
          return committedCommand.result;
        }

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const cleanup of committedCommand.attachmentCleanups) {
          yield* cleanup;
        }
        incrementWorkloadCounter(
          "orchestration.events.durable",
          committedCommand.committedEvents.length,
        );
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (dispatchAttemptedEffects) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );
          }

          if (isOrchestrationCommandInvariantError(error)) {
            const durableRejection = yield* Effect.exit(
              Effect.gen(function* () {
                const inserted = yield* commandReceiptRepository.insertRejected({
                  ...receiptIdentity,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  error: error.message,
                });
                if (inserted) {
                  return yield* error;
                }
                const winningReceipt = yield* commandReceiptRepository.getByCommandId({
                  commandId: receiptIdentity.commandId,
                });
                if (Option.isNone(winningReceipt)) {
                  return yield* new PersistenceSqlError({
                    operation: "OrchestrationEngine.processEnvelope:reject",
                    detail:
                      "Rejected command receipt insert lost without a durable winning receipt.",
                  });
                }
                return yield* resolveExistingReceipt(winningReceipt.value, receiptIdentity);
              }),
            );
            if (Exit.isSuccess(durableRejection)) {
              yield* Deferred.succeed(envelope.result, durableRejection.value);
            } else {
              yield* Deferred.fail(
                envelope.result,
                Cause.squash(durableRejection.cause) as OrchestrationDispatchError,
              );
            }
            return;
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);
  const readAggregateEvents: OrchestrationEngineShape["readAggregateEvents"] = (
    aggregateKind,
    aggregateId,
    fromSequenceExclusive,
    limit,
  ) => {
    if (eventStore.readAggregateFromSequence !== undefined) {
      return eventStore.readAggregateFromSequence(
        aggregateKind,
        aggregateId,
        fromSequenceExclusive,
        limit,
      );
    }
    return eventStore.readFromSequence(fromSequenceExclusive, Number.MAX_SAFE_INTEGER).pipe(
      Stream.filter(
        (event) =>
          event.aggregateKind === aggregateKind && event.aggregateId === String(aggregateId),
      ),
      Stream.take(limit ?? 1_000),
    );
  };
  const probeFromSequence = eventStore.probeFromSequence;
  const probeAggregateFromSequence = eventStore.probeAggregateFromSequence;
  const replayProbeCapability =
    probeFromSequence === undefined || probeAggregateFromSequence === undefined
      ? undefined
      : {
          kind: "payload-free-v1" as const,
          probeReplay: (fromSequenceExclusive: number, maxEvents: number) =>
            probeFromSequence(fromSequenceExclusive, maxEvents),
          probeAggregateReplay: (
            aggregateKind: OrchestrationAggregateKind,
            aggregateId: ProjectId | ThreadId | ProviderInstanceId,
            fromSequenceExclusive: number,
            maxEvents: number,
          ) =>
            probeAggregateFromSequence(
              aggregateKind,
              aggregateId,
              fromSequenceExclusive,
              maxEvents,
            ),
        };

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        origin: options?.origin,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    readAggregateEvents,
    ...(replayProbeCapability === undefined ? {} : { replayProbeCapability }),
    liveSubscriptionCapability: {
      kind: "scoped-v1",
      subscribe: PubSub.subscribe(eventPubSub).pipe(
        Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
      ),
    },
    dispatch,
    resolveReceipt,
    subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(
      Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
    ),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
