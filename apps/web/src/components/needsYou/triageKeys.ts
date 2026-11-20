import { isImeCompositionKey } from "~/composer-logic";

export type TriageKeyAction = "next" | "previous" | "open" | "snooze" | "dismiss";

const ACTIONS: Record<string, TriageKeyAction> = {
  j: "next",
  k: "previous",
  o: "open",
  s: "snooze",
  x: "dismiss",
};

interface TriageKeyEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
  readonly defaultPrevented: boolean;
}

/**
 * Where a key landed: in a field or editor, in a layer above the deck (a menu, the page's full
 * screen view), or on the deck. A page's own frame keeps its keys, since they never leave it.
 */
export type TriageKeyTarget = "typing" | "layer" | "deck";

export function triageKeyTarget(target: EventTarget | null): TriageKeyTarget {
  if (!(target instanceof Element)) return "deck";
  if (
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
    null
  ) {
    return "typing";
  }
  return target.closest(
    '[role="dialog"]:not([data-app-modal]), [role="alertdialog"], [role="menu"], [data-slot$="popup"]:not([data-app-modal])',
  ) === null
    ? "deck"
    : "layer";
}

function isPlainKey(event: TriageKeyEvent) {
  return (
    !event.defaultPrevented &&
    !isImeCompositionKey(event) &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** The deck's one-letter shortcuts. They leave modifier chords to the app's own shortcuts. */
export function triageKeyAction(
  event: TriageKeyEvent,
  target: TriageKeyTarget,
): TriageKeyAction | null {
  if (target !== "deck" || !isPlainKey(event)) return null;
  const action = ACTIONS[event.key.toLowerCase()] ?? null;
  // A held key pages through cards, but acts on one card once.
  if (event.repeat && action !== "next" && action !== "previous") return null;
  return action;
}

/**
 * The one Esc that leaves the reply box or closes triage: no modifier, no IME, and not held, so
 * the Esc that left the box does not go on to close triage.
 */
export function isTriageEscape(event: TriageKeyEvent) {
  return event.key === "Escape" && !event.repeat && isPlainKey(event);
}

/** Esc closes triage from the deck, not from the reply box, which it leaves first. */
export function triageEscapeCloses(event: TriageKeyEvent, target: TriageKeyTarget) {
  return target === "deck" && isTriageEscape(event);
}

/** Plain Enter sends the reply; Shift+Enter is a new line, and IME and other chords never send. */
export function triageReplySends(event: TriageKeyEvent) {
  return event.key === "Enter" && !event.repeat && isPlainKey(event);
}
