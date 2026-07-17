import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import type { ProviderTranscriptJournalEntry } from "../persistence/Services/ProviderTranscriptJournal.ts";

const MAX_ASSISTANT_DELTA_BATCH_CHARS = 24_000;
const MAX_ASSISTANT_DELTA_BATCH_EVENTS = 128;

export interface ProviderTranscriptJournalBatch {
  readonly event: ProviderRuntimeEvent;
  readonly sourceEvents: ReadonlyArray<ProviderRuntimeEvent>;
}

export type ProviderTranscriptJournalBatchKind = "assistant_delta" | "single";

export function providerTranscriptJournalBatchKind(
  batch: ProviderTranscriptJournalBatch,
): ProviderTranscriptJournalBatchKind {
  return isBatchableParentAssistantDelta(batch.event) ? "assistant_delta" : "single";
}

export function providerTranscriptJournalBatchCharacterCount(
  batch: ProviderTranscriptJournalBatch,
): number {
  return isBatchableParentAssistantDelta(batch.event) ? batch.event.payload.delta.length : 0;
}

type AssistantDeltaEvent = Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;

interface PendingAssistantDeltaBatch {
  readonly firstIndex: number;
  readonly sourceEvents: Array<AssistantDeltaEvent>;
  characterCount: number;
  sealed: boolean;
}

export function isBatchableParentAssistantDelta(
  event: ProviderRuntimeEvent,
): event is AssistantDeltaEvent {
  return (
    event.type === "content.delta" &&
    event.payload.streamKind === "assistant_text" &&
    event.itemId !== undefined &&
    event.agentContext === undefined
  );
}

function assistantDeltaScope(event: AssistantDeltaEvent): string {
  return [
    event.provider,
    event.providerInstanceId ?? event.provider,
    event.threadId,
    event.turnId ?? "",
    event.itemId ?? "",
  ].join("\0");
}

function assistantDeltaTurnScope(event: AssistantDeltaEvent): string {
  return [
    event.provider,
    event.providerInstanceId ?? event.provider,
    event.threadId,
    event.turnId ?? "",
  ].join("\0");
}

export function batchProviderTranscriptJournalEntries(
  entries: ReadonlyArray<ProviderTranscriptJournalEntry>,
): ReadonlyArray<ProviderTranscriptJournalBatch> {
  const batches: ProviderTranscriptJournalBatch[] = [];
  const pendingByTurn = new Map<string, Array<PendingAssistantDeltaBatch>>();

  function appendBatch(sourceEvents: ReadonlyArray<AssistantDeltaEvent>): void {
    const firstEvent = sourceEvents[0];
    if (firstEvent === undefined) return;
    batches.push({
      event:
        sourceEvents.length === 1
          ? firstEvent
          : {
              ...firstEvent,
              payload: {
                ...firstEvent.payload,
                delta: sourceEvents.map((event) => event.payload.delta).join(""),
              },
            },
      sourceEvents,
    });
  }

  function flushPending(sealOpenBatches: boolean): void {
    const pending = [...pendingByTurn.values()].flat();
    pending.sort((left, right) => left.firstIndex - right.firstIndex);
    for (const pendingBatch of pending) {
      if (sealOpenBatches || pendingBatch.sealed) {
        appendBatch(pendingBatch.sourceEvents);
        continue;
      }
      for (const sourceEvent of pendingBatch.sourceEvents) {
        appendBatch([sourceEvent]);
      }
    }
    pendingByTurn.clear();
  }

  for (const [index, { event }] of entries.entries()) {
    if (!isBatchableParentAssistantDelta(event)) {
      flushPending(true);
      batches.push({ event, sourceEvents: [event] });
      continue;
    }

    const turnScope = assistantDeltaTurnScope(event);
    const scopeBatches = pendingByTurn.get(turnScope) ?? [];
    const currentBatch = scopeBatches.at(-1);
    const firstCurrentEvent = currentBatch?.sourceEvents[0];
    const startsNewBatch =
      currentBatch === undefined ||
      currentBatch.sealed ||
      firstCurrentEvent === undefined ||
      assistantDeltaScope(firstCurrentEvent) !== assistantDeltaScope(event) ||
      currentBatch.characterCount + event.payload.delta.length > MAX_ASSISTANT_DELTA_BATCH_CHARS;
    if (startsNewBatch) {
      if (currentBatch !== undefined && !currentBatch.sealed) {
        currentBatch.sealed = true;
      }
      scopeBatches.push({
        firstIndex: index,
        sourceEvents: [event],
        characterCount: event.payload.delta.length,
        sealed: event.payload.delta.length >= MAX_ASSISTANT_DELTA_BATCH_CHARS,
      });
    } else {
      currentBatch.sourceEvents.push(event);
      currentBatch.characterCount += event.payload.delta.length;
      currentBatch.sealed =
        currentBatch.characterCount >= MAX_ASSISTANT_DELTA_BATCH_CHARS ||
        currentBatch.sourceEvents.length >= MAX_ASSISTANT_DELTA_BATCH_EVENTS;
    }
    pendingByTurn.set(turnScope, scopeBatches);
  }
  // A final partial batch can still gain newly accepted tail events before its
  // acknowledgment is durable. Keep those events individual so replay command
  // identity never changes across a crash. Full batches and hard barriers are
  // stable because later rows cannot change their membership.
  flushPending(false);
  return batches;
}
