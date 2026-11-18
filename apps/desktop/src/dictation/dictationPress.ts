import type { DesktopDictationGesture } from "@t3tools/contracts";

/** Chord keys arrived up to 285 ms after Fn on a MacBook; a press this long without one is a hold. */
export const DICTATION_HOLD_MS = 300;

export type DictationModifiers = { readonly shift: boolean; readonly control: boolean };

export type DictationKeyInput =
  | { readonly type: "down"; readonly modifiers: DictationModifiers }
  | { readonly type: "modifiers"; readonly modifiers: DictationModifiers }
  | { readonly type: "key" }
  | { readonly type: "up" }
  /** The press has lasted `DICTATION_HOLD_MS`. */
  | { readonly type: "held" };

export type DictationPressOutput =
  | { readonly type: "tap" | "hold" | "gesture"; readonly gesture: DesktopDictationGesture }
  | { readonly type: "release" | "cancel" };

export type DictationPressState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "pressed";
      readonly gesture: DesktopDictationGesture;
      readonly held: boolean;
      readonly chord: boolean;
    };

export const IDLE_DICTATION_PRESS: DictationPressState = { phase: "idle" };

// Control wins over Shift: a rewrite must never land as a new draft by accident.
function gestureFor(current: DesktopDictationGesture, modifiers: DictationModifiers) {
  if (current === "command" || modifiers.control) return "command";
  if (current === "draft" || modifiers.shift) return "draft";
  return "dictate";
}

/**
 * Turns raw key state into gestures. Another key during the press makes it a chord such as
 * Fn+Delete: before the hold threshold nothing starts, after it the started recording cancels.
 */
export function stepDictationPress(
  state: DictationPressState,
  input: DictationKeyInput,
): { readonly state: DictationPressState; readonly output: DictationPressOutput | null } {
  if (state.phase === "idle") {
    if (input.type !== "down") return { state, output: null };
    return {
      state: {
        phase: "pressed",
        gesture: gestureFor("dictate", input.modifiers),
        held: false,
        chord: false,
      },
      output: null,
    };
  }
  switch (input.type) {
    case "down":
      return { state, output: null };
    case "modifiers": {
      const gesture = gestureFor(state.gesture, input.modifiers);
      if (gesture === state.gesture) return { state, output: null };
      return {
        state: { ...state, gesture },
        output: state.held && !state.chord ? { type: "gesture", gesture } : null,
      };
    }
    case "key":
      if (state.chord) return { state, output: null };
      return {
        state: { ...state, chord: true },
        output: state.held ? { type: "cancel" } : null,
      };
    case "held":
      if (state.held || state.chord) return { state, output: null };
      return { state: { ...state, held: true }, output: { type: "hold", gesture: state.gesture } };
    case "up":
      if (state.chord) return { state: IDLE_DICTATION_PRESS, output: null };
      return {
        state: IDLE_DICTATION_PRESS,
        output: state.held ? { type: "release" } : { type: "tap", gesture: state.gesture },
      };
  }
}
