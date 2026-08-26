import {
  type MessageId,
  type ProviderRuntimeEvent,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { incrementWorkloadCounter } from "../diagnostics/WorkloadDiagnostics.ts";
import {
  makeTranscriptJournalTracker,
  observeTranscriptJournalBatch,
  TranscriptJournalTracker,
  type TranscriptJournalIngestionPhase,
} from "../observability/TranscriptJournalObservability.ts";
import { isPersistenceError } from "../persistence/Errors.ts";
import {
  ProviderTranscriptJournal,
  type ProviderTranscriptJournalEntry,
} from "../persistence/Services/ProviderTranscriptJournal.ts";
import { isTranscriptDurabilityEvent } from "../provider/ProviderRuntimeEventDurability.ts";
import {
  batchProviderTranscriptJournalEntries,
  isBatchableParentAssistantDelta,
  planProviderTranscriptJournalBatchSeals,
  type ProviderTranscriptJournalBatch,
} from "./ProviderTranscriptJournalBatch.ts";
import { isSubagentRuntimeEvent } from "./ProviderSubagentActivityProjection.ts";

function transcriptItemScopeKey(event: ProviderRuntimeEvent): string | null {
  if (event.itemId === undefined) return null;
  return `${event.provider}\0${event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider)}\0${event.threadId}\0${event.turnId ?? ""}\0${event.itemId}`;
}

export function makeProviderTranscriptJournalIngestion(input: {
  readonly hasProcessed: (event: ProviderRuntimeEvent) => boolean;
  readonly rememberProcessed: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const transcriptJournal = yield* ProviderTranscriptJournal;
    const trackerOption = yield* Effect.serviceOption(TranscriptJournalTracker);
    const tracker = Option.isSome(trackerOption)
      ? trackerOption.value
      : yield* makeTranscriptJournalTracker;
    const recoveringCountByScope = new Map<string, number>();
    const recoveredItemScopes = new Set<string>();
    const durableParentDeltaPromotions = new Map<string, Array<ProviderRuntimeEvent>>();
    const batchSourcesByEventId = new Map<string, ReadonlyArray<ProviderRuntimeEvent>>();
    const bufferedAssistantEventsByMessageId = new Map<MessageId, Array<ProviderRuntimeEvent>>();

    const sourceEvents = (event: ProviderRuntimeEvent) =>
      batchSourcesByEventId.get(String(event.eventId)) ?? [event];

    const isRecoveringItem = (event: ProviderRuntimeEvent): boolean => {
      const scopeKey = transcriptItemScopeKey(event);
      return scopeKey !== null && recoveringCountByScope.has(scopeKey);
    };

    const consumeRecoveredItemContinuation = (event: ProviderRuntimeEvent): boolean => {
      const scopeKey = transcriptItemScopeKey(event);
      if (scopeKey === null || !recoveredItemScopes.has(scopeKey)) return false;
      recoveredItemScopes.delete(scopeKey);
      return true;
    };

    const bufferAssistantSourceEvents = (messageId: MessageId, event: ProviderRuntimeEvent) => {
      const buffered = bufferedAssistantEventsByMessageId.get(messageId);
      const events = sourceEvents(event);
      if (buffered === undefined) {
        bufferedAssistantEventsByMessageId.set(messageId, [...events]);
      } else {
        buffered.push(...events);
      }
    };

    const promoteEvents = (
      boundaryEvent: ProviderRuntimeEvent,
      events: ReadonlyArray<ProviderRuntimeEvent>,
    ) => {
      if (events.length === 0) return;
      const key = String(boundaryEvent.eventId);
      const promoted = durableParentDeltaPromotions.get(key);
      if (promoted === undefined) {
        durableParentDeltaPromotions.set(key, [...events]);
      } else {
        promoted.push(...events);
      }
    };

    const promoteBufferedAssistantEvents = (
      messageId: MessageId,
      boundaryEvent: ProviderRuntimeEvent,
    ) => {
      const events = bufferedAssistantEventsByMessageId.get(messageId) ?? [];
      bufferedAssistantEventsByMessageId.delete(messageId);
      promoteEvents(boundaryEvent, events);
    };

    const promoteSourceEvents = (event: ProviderRuntimeEvent) =>
      promoteEvents(event, sourceEvents(event));

    const clearBufferedAssistantEvents = (messageId: MessageId) => {
      bufferedAssistantEventsByMessageId.delete(messageId);
    };

    const retryPersistence = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
      effect.pipe(
        Effect.retry({
          schedule: Schedule.spaced("50 millis"),
          while: (error) => {
            if (!isPersistenceError(error)) return false;
            incrementWorkloadCounter("ingestion.activity.persistence_retries");
            return true;
          },
        }),
      );

    const removePromotedEvent = (event: ProviderRuntimeEvent) => {
      if (!isTranscriptDurabilityEvent(event)) return Effect.void;
      if (isSubagentRuntimeEvent(event)) {
        if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
          return retryPersistence(transcriptJournal.markItemCompleted(event)).pipe(
            Effect.andThen(retryPersistence(transcriptJournal.removeItem(event))),
          );
        }
        return retryPersistence(transcriptJournal.remove(event));
      }

      const promotedEvents = durableParentDeltaPromotions.get(String(event.eventId)) ?? [];
      durableParentDeltaPromotions.delete(String(event.eventId));
      const removePromotedEvents = retryPersistence(transcriptJournal.removeMany(promotedEvents));
      if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
        return removePromotedEvents.pipe(
          Effect.andThen(retryPersistence(transcriptJournal.markItemCompleted(event))),
          Effect.andThen(retryPersistence(transcriptJournal.removeItem(event))),
          Effect.tap(() =>
            Effect.sync(() => {
              const scopeKey = transcriptItemScopeKey(event);
              if (scopeKey !== null) recoveringCountByScope.delete(scopeKey);
            }),
          ),
        );
      }
      if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
        return removePromotedEvents;
      }
      // Lifecycle rows are retired by identity only. Sweeping an acceptance
      // sequence could remove an earlier row that has not reached delivery.
      return removePromotedEvents.pipe(
        Effect.andThen(retryPersistence(transcriptJournal.remove(event))),
      );
    };

    const processBatch = <E, R>(
      batch: ProviderTranscriptJournalBatch,
      phase: TranscriptJournalIngestionPhase,
      processEvent: (
        event: ProviderRuntimeEvent,
        journalBacked: boolean,
      ) => Effect.Effect<void, E, R>,
    ) => {
      const { event, sourceEvents: batchSourceEvents } = batch;
      return Effect.gen(function* () {
        if (batchSourceEvents.length > 1) {
          batchSourcesByEventId.set(String(event.eventId), batchSourceEvents);
        }
        if (
          event.itemId !== undefined &&
          (event.type === "content.delta" ||
            (event.type === "item.completed" && event.payload.itemType === "assistant_message")) &&
          (yield* retryPersistence(transcriptJournal.isItemCompleted(event)))
        ) {
          incrementWorkloadCounter("provider.events.duplicates_suppressed");
          yield* retryPersistence(transcriptJournal.removeMany(batchSourceEvents));
          return;
        }
        yield* retryPersistence(processEvent(event, true));
        yield* Effect.forEach(batchSourceEvents.slice(1), input.rememberProcessed, {
          concurrency: 1,
          discard: true,
        });
        yield* retryPersistence(transcriptJournal.markDeliveredMany(batchSourceEvents));
        yield* removePromotedEvent(event);
      }).pipe(
        Effect.ensuring(Effect.sync(() => batchSourcesByEventId.delete(String(event.eventId)))),
        (effect) => observeTranscriptJournalBatch({ tracker, phase, batch, effect }),
      );
    };

    const sealPending = <E>(
      pending: ReadonlyArray<ProviderTranscriptJournalEntry>,
      reload: Effect.Effect<ReadonlyArray<ProviderTranscriptJournalEntry>, E>,
    ) => {
      const seals = planProviderTranscriptJournalBatchSeals(pending);
      if (seals.length === 0) return Effect.succeed(pending);
      return retryPersistence(transcriptJournal.sealBatches(seals)).pipe(
        Effect.andThen(retryPersistence(reload)),
      );
    };

    const drain = <E, R>(
      fallbackEvent: ProviderRuntimeEvent | undefined,
      processEvent: (
        event: ProviderRuntimeEvent,
        journalBacked: boolean,
      ) => Effect.Effect<void, E, R>,
    ) =>
      Effect.gen(function* () {
        let pending = yield* retryPersistence(transcriptJournal.listUndelivered);
        if (
          fallbackEvent !== undefined &&
          isBatchableParentAssistantDelta(fallbackEvent) &&
          pending.some(({ event }) => event.eventId === fallbackEvent.eventId)
        ) {
          // Give the durable adapter burst one frame to coalesce while keeping
          // interactive token delivery visually live.
          yield* Effect.sleep("16 millis");
          pending = yield* retryPersistence(transcriptJournal.listUndelivered);
        }
        const relevantPending =
          fallbackEvent === undefined
            ? pending
            : pending.filter(({ event }) => event.threadId === fallbackEvent.threadId);
        const sealedPending = yield* sealPending(
          relevantPending,
          transcriptJournal.listUndelivered.pipe(
            Effect.map((entries) =>
              fallbackEvent === undefined
                ? entries
                : entries.filter(({ event }) => event.threadId === fallbackEvent.threadId),
            ),
          ),
        );
        yield* tracker.registerEntries(sealedPending);
        let fallbackWasJournaled = false;
        for (const batch of batchProviderTranscriptJournalEntries(sealedPending)) {
          if (fallbackEvent !== undefined) {
            fallbackWasJournaled ||= batch.sourceEvents.some(
              (event) =>
                event.eventId === fallbackEvent.eventId &&
                (event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider)) ===
                  (fallbackEvent.providerInstanceId ??
                    defaultInstanceIdForDriver(fallbackEvent.provider)),
            );
          }
          yield* processBatch(batch, "live", processEvent);
        }
        if (
          fallbackEvent !== undefined &&
          !fallbackWasJournaled &&
          !input.hasProcessed(fallbackEvent)
        ) {
          yield* processEvent(fallbackEvent, false);
        }
      });

    const recover = <E, R, E2, R2>(
      processEvent: (
        event: ProviderRuntimeEvent,
        journalBacked: boolean,
      ) => Effect.Effect<void, E, R>,
      afterRecovery: Effect.Effect<void, E2, R2>,
    ) =>
      Effect.gen(function* () {
        let pending = yield* retryPersistence(transcriptJournal.list).pipe(Effect.orDie);
        pending = yield* sealPending(pending, transcriptJournal.list).pipe(Effect.orDie);
        const initiallyUndelivered = yield* retryPersistence(
          transcriptJournal.listUndelivered,
        ).pipe(Effect.orDie);
        yield* tracker.hydrateOnce(initiallyUndelivered);
        for (const { event } of pending) {
          const scopeKey = transcriptItemScopeKey(event);
          if (
            scopeKey !== null &&
            event.type === "content.delta" &&
            event.payload.streamKind === "assistant_text"
          ) {
            recoveringCountByScope.set(scopeKey, (recoveringCountByScope.get(scopeKey) ?? 0) + 1);
            recoveredItemScopes.add(scopeKey);
          }
        }

        const batches = batchProviderTranscriptJournalEntries(pending);
        yield* tracker.beginRecovery({
          batchCount: batches.length,
          sourceEventCount: pending.length,
        });
        yield* Effect.forEach(
          batches,
          (batch) =>
            processBatch(batch, "recovery", processEvent).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  const scopeKey = transcriptItemScopeKey(batch.event);
                  if (scopeKey === null) return;
                  const remaining = recoveringCountByScope.get(scopeKey);
                  if (remaining === undefined) return;
                  if (remaining > batch.sourceEvents.length) {
                    recoveringCountByScope.set(scopeKey, remaining - batch.sourceEvents.length);
                  } else {
                    recoveringCountByScope.delete(scopeKey);
                  }
                }),
              ),
              Effect.catch(() => Effect.void),
            ),
          { concurrency: 1, discard: true },
        ).pipe(Effect.ensuring(tracker.finishRecovery));
        yield* afterRecovery.pipe(
          Effect.catch((error) =>
            Effect.logWarning("provider transcript journal post-recovery flush failed", {
              error,
            }),
          ),
        );
      });

    const reset = Effect.sync(() => {
      recoveringCountByScope.clear();
      recoveredItemScopes.clear();
      durableParentDeltaPromotions.clear();
      batchSourcesByEventId.clear();
      bufferedAssistantEventsByMessageId.clear();
    }).pipe(Effect.andThen(tracker.reset));

    return {
      accepts: isTranscriptDurabilityEvent,
      isRecoveringItem,
      consumeRecoveredItemContinuation,
      bufferAssistantSourceEvents,
      promoteBufferedAssistantEvents,
      promoteSourceEvents,
      clearBufferedAssistantEvents,
      drain,
      recover,
      reset,
    } as const;
  });
}
