import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import type { DesktopDictationGesture } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

/** The editor dictation running in T3, which the desktop pill mirrors while T3 is in the background. */
export type ActiveRecording = {
  readonly ownerKey: string;
  readonly phase: VoiceInputPhase;
  readonly gesture: DesktopDictationGesture;
  readonly level: number;
  readonly preview: string | null;
};

let current: ActiveRecording | null = null;
const listeners = new Set<() => void>();

/** Only one recording runs at a time, so an owner clears only its own entry. */
export function publishRecording(ownerKey: string, recording: ActiveRecording | null) {
  if (recording === null && current?.ownerKey !== ownerKey) return;
  current = recording;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActiveRecording() {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
