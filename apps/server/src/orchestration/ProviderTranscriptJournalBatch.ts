import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import type { ProviderTranscriptJournalEntry } from "../persistence/Services/ProviderTranscriptJournal.ts";

const MAX_ASSISTANT_DELTA_BATCH_CHARS = 24_000;

export interface ProviderTranscriptJournalBatch {
  readonly event: ProviderRuntimeEvent;
  readonly sourceEvents: ReadonlyArray<ProviderRuntimeEvent>;
}

type AssistantDeltaEvent = Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;

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

export function batchProviderTranscriptJournalEntries(
  entries: ReadonlyArray<ProviderTranscriptJournalEntry>,
): ReadonlyArray<ProviderTranscriptJournalBatch> {
  const batches: ProviderTranscriptJournalBatch[] = [];
  let index = 0;
  while (index < entries.length) {
    const firstEvent = entries[index]?.event;
    if (firstEvent === undefined) break;
    if (!isBatchableParentAssistantDelta(firstEvent)) {
      batches.push({ event: firstEvent, sourceEvents: [firstEvent] });
      index += 1;
      continue;
    }

    const scope = assistantDeltaScope(firstEvent);
    const sourceEvents: ProviderRuntimeEvent[] = [firstEvent];
    const chunks = [firstEvent.payload.delta];
    let characterCount = firstEvent.payload.delta.length;
    let nextIndex = index + 1;
    while (nextIndex < entries.length) {
      const nextEvent = entries[nextIndex]?.event;
      if (
        nextEvent === undefined ||
        !isBatchableParentAssistantDelta(nextEvent) ||
        assistantDeltaScope(nextEvent) !== scope ||
        characterCount + nextEvent.payload.delta.length > MAX_ASSISTANT_DELTA_BATCH_CHARS
      ) {
        break;
      }
      sourceEvents.push(nextEvent);
      chunks.push(nextEvent.payload.delta);
      characterCount += nextEvent.payload.delta.length;
      nextIndex += 1;
    }

    const lastEvent = sourceEvents.at(-1) ?? firstEvent;
    batches.push({
      event:
        sourceEvents.length === 1
          ? firstEvent
          : {
              ...firstEvent,
              createdAt: lastEvent.createdAt,
              payload: { ...firstEvent.payload, delta: chunks.join("") },
            },
      sourceEvents,
    });
    index = nextIndex;
  }
  return batches;
}
