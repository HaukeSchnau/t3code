import type { ProjectId } from "@t3tools/contracts";
import type {
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectOrchestrationCommand,
} from "@t3tools/contracts/legacy-orchestration";
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
import { commandEnvelopeFingerprint } from "../CommandEnvelope.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
} from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandInvariantError,
  type OrchestrationCommandRejection,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandReceiptMismatchError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandReceiptMismatchError = Schema.is(
  OrchestrationCommandReceiptMismatchError,
);

interface CommandEnvelope {
  command: ProjectOrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: ProjectOrchestrationCommand): {
  readonly aggregateKind: "project";
  readonly aggregateId: ProjectId;
} {
  return { aggregateKind: "project", aggregateId: command.projectId };
}

function validateCommandReceipt(
  command: ProjectOrchestrationCommand,
  receipt: OrchestrationCommandReceipt,
  fingerprint: string,
) {
  const aggregate = commandToAggregateRef(command);
  if (receipt.aggregateKind !== aggregate.aggregateKind || receipt.aggregateId !== aggregate.aggregateId) {
    return Effect.fail(
      new OrchestrationCommandReceiptMismatchError({
        commandId: command.commandId,
        reason: "aggregate-mismatch",
        detail: "The command receipt belongs to a different project.",
      }),
    );
  }
  // A receipt predating envelope fingerprints cannot prove that it represents
  // this command. Keep those rows immutable and fail closed on replay.
  if (receipt.envelopeFingerprint == null) {
    return Effect.fail(
      new OrchestrationCommandReceiptMismatchError({
        commandId: command.commandId,
        reason: "legacy-unverifiable",
        detail: "The command receipt predates durable envelope identity.",
      }),
    );
  }
  if (receipt.commandType !== command.type || receipt.commandVariant !== command.type) {
    return Effect.fail(
      new OrchestrationCommandReceiptMismatchError({
        commandId: command.commandId,
        reason: "variant-mismatch",
        detail: "The command receipt belongs to a different command variant.",
      }),
    );
  }
  if (receipt.envelopeFingerprint !== fingerprint) {
    return Effect.fail(
      new OrchestrationCommandReceiptMismatchError({
        commandId: command.commandId,
        reason: "payload-mismatch",
        detail: "The canonical command envelope differs from the command receipt.",
      }),
    );
  }
  return Effect.void;
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
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

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const fingerprint = commandEnvelopeFingerprint(envelope.command);
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

      yield* eventStore.publishCommitted(
        persistedEvents.filter(
          (event) =>
            event.type === "project.created" ||
            event.type === "project.meta-updated" ||
            event.type === "project.deleted",
        ),
      );

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    // Rejected commands do not append events, so they used to claim their
    // receipt only from the failure handler after read-model reconciliation.
    // Claim and finalize the full envelope in one transaction first. This
    // keeps a retry or a concurrent dispatcher from running rejection side
    // effects before the command identity is durable.
    const recordRejectedReceipt = (error: OrchestrationCommandRejection) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const acceptedAt = yield* nowIso;
          const reserved = yield* commandReceiptRepository.insertIfAbsent({
            commandId: envelope.command.commandId,
            aggregateKind: aggregateRef.aggregateKind,
            aggregateId: aggregateRef.aggregateId,
            commandType: envelope.command.type,
            commandVariant: envelope.command.type,
            envelopeFingerprint: fingerprint,
            acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (reserved) {
            yield* commandReceiptRepository.upsert({
              commandId: envelope.command.commandId,
              aggregateKind: aggregateRef.aggregateKind,
              aggregateId: aggregateRef.aggregateId,
              commandType: envelope.command.type,
              commandVariant: envelope.command.type,
              envelopeFingerprint: fingerprint,
              acceptedAt,
              resultSequence: commandReadModel.snapshotSequence,
              status: "rejected",
              error: error.message,
            });
            return;
          }

          const existing = yield* commandReceiptRepository.getByCommandId({
            commandId: envelope.command.commandId,
          });
          if (Option.isNone(existing)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail: "Command receipt disappeared after its transactional claim.",
            });
          }
          yield* validateCommandReceipt(envelope.command, existing.value, fingerprint);
        }),
      );

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
          yield* validateCommandReceipt(envelope.command, existingReceipt.value, fingerprint);
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandRejection(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
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
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const reserved = yield* commandReceiptRepository.insertIfAbsent({
                commandId: envelope.command.commandId,
                aggregateKind: aggregateRef.aggregateKind,
                aggregateId: aggregateRef.aggregateId,
                commandType: envelope.command.type,
                commandVariant: envelope.command.type,
                envelopeFingerprint: fingerprint,
                acceptedAt: yield* nowIso,
                resultSequence: 0,
                status: "accepted",
                error: null,
              });
              if (!reserved) {
                const existing = yield* commandReceiptRepository.getByCommandId({
                  commandId: envelope.command.commandId,
                });
                if (Option.isNone(existing)) {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Command receipt disappeared after its transactional claim.",
                  });
                }
                yield* validateCommandReceipt(envelope.command, existing.value, fingerprint);
                return {
                  committed: false as const,
                  committedEvents: [] as OrchestrationEvent[],
                  attachmentCleanups: [] as Effect.Effect<void>[],
                  lastSequence: existing.value.resultSequence,
                  nextCommandReadModel: commandReadModel,
                  status: existing.value.status,
                } as const;
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
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                commandType: envelope.command.type,
                commandVariant: envelope.command.type,
                envelopeFingerprint: fingerprint,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committed: true as const,
                committedEvents,
                attachmentCleanups,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
                status: "accepted" as const,
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

        if (!committedCommand.committed) {
          if (committedCommand.status === "rejected") {
            return yield* new OrchestrationCommandPreviouslyRejectedError({
              commandId: envelope.command.commandId,
              detail: "Previously rejected.",
            });
          }
          return { sequence: committedCommand.lastSequence };
        }

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const cleanup of committedCommand.attachmentCleanups) {
          yield* cleanup;
        }
        yield* eventStore.publishCommitted(
          committedCommand.committedEvents.filter(
            (event) =>
              event.type === "project.created" ||
              event.type === "project.meta-updated" ||
              event.type === "project.deleted",
          ),
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
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandReceiptMismatchError(error)
          ) {
            if (isOrchestrationCommandRejection(error)) {
              yield* recordRejectedReceipt(error).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("failed to claim rejected orchestration command receipt", {
                    commandId: envelope.command.commandId,
                    cause,
                  }),
                ),
              );
            }

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
    dispatch,
    subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(Effect.map(Stream.fromSubscription)),
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
