import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { isPersistenceError } from "../persistence/Errors.ts";
import type { ProviderTranscriptJournalShape } from "../persistence/Services/ProviderTranscriptJournal.ts";
import { incrementWorkloadCounter } from "../diagnostics/WorkloadDiagnostics.ts";
import type { TranscriptJournalTrackerShape } from "../observability/TranscriptJournalObservability.ts";
import type { ProviderRuntimeEventAcceptance } from "./Services/ProviderAdapter.ts";

/** Events needed to reconstruct or durably finalize assistant transcript text. */
export function isTranscriptDurabilityEvent(event: ProviderRuntimeEvent): boolean {
  if (event.type === "content.delta") {
    return (
      event.payload.streamKind === "assistant_text" &&
      typeof event.payload.delta === "string" &&
      event.payload.delta.length > 0
    );
  }
  if (event.type === "item.completed") {
    return event.payload.itemType === "assistant_message";
  }
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "runtime.error" ||
    event.type === "session.exited" ||
    event.type === "request.opened" ||
    event.type === "user-input.requested"
  );
}

/**
 * Build the adapter-side acceptance gate. `true` means the event was newly
 * accepted and may enter volatile delivery; `false` suppresses an exact
 * delivery that is already pending in the durable journal.
 */
export function makeDurableRuntimeEventAcceptance(
  journal: ProviderTranscriptJournalShape,
  tracker?: TranscriptJournalTrackerShape,
): ProviderRuntimeEventAcceptance {
  return (event) => {
    if (!isTranscriptDurabilityEvent(event)) return Effect.succeed(true);
    // Native diagnostics belong to bounded rotating logs. Recovery only
    // needs canonical fields, so do not duplicate arbitrary raw payloads.
    const { raw: _raw, ...durableEvent } = event;
    const journalEvent = durableEvent as ProviderRuntimeEvent;
    // The journal's conditional INSERT establishes one SQLite ordering point
    // for deltas and item completion. Once completion is accepted, a later
    // delivery for the same item is rejected before any volatile queue.
    return journal.append(journalEvent).pipe(
      Effect.retry({
        schedule: Schedule.spaced("50 millis"),
        while: (error) => {
          if (!isPersistenceError(error)) return false;
          incrementWorkloadCounter("ingestion.activity.persistence_retries");
          return true;
        },
      }),
      Effect.tap((accepted) =>
        accepted && tracker !== undefined ? tracker.registerAccepted(journalEvent) : Effect.void,
      ),
      Effect.orDie,
    );
  };
}
