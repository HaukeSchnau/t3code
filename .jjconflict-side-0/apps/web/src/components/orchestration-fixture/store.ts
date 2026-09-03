/**
 * Fixture store: the scenario cursor, the user's own appended events, and the
 * Work panel's presentation state.
 *
 * Derived state is one reduction over the scripted steps up to the cursor
 * plus the user events recorded at or before that step. Stepping back hides
 * later user actions; Reset drops them. The reduction is memoized on the
 * inputs' identities so subscribers get stable references.
 */
import { create } from "zustand";

import type { FixtureEvent, FixtureState } from "./model";
import { reduceFixtureEvents } from "./reducer";
import type { LensKind } from "./reducer";
import { COORDINATOR_ID, FIXTURE_STEPS } from "./scenario";

const ENABLED_STORAGE_KEY = "t3code:fixtures:orchestration:enabled:v1";

/** Seconds added per user action so appended facts stay strictly ordered. */
const USER_EVENT_SPACING_MS = 30_000;

export type FixtureUserEventInput = FixtureEvent extends infer E
  ? E extends { readonly at: string }
    ? Omit<E, "at">
    : never
  : never;

interface FixtureUserEvent {
  readonly stepIndex: number;
  readonly event: FixtureEvent;
}

export type WorkPanelMode = "work" | "compare";

interface FixtureStore {
  readonly enabled: boolean;
  readonly cursor: number;
  readonly userEvents: ReadonlyArray<FixtureUserEvent>;
  /** Standalone-route navigation; the integrated route uses the real router. */
  readonly openThreadId: string | null;
  readonly panelOpen: boolean;
  readonly panelMode: WorkPanelMode;
  readonly selectedThreadIds: ReadonlyArray<string>;
  readonly lens: LensKind | null;
  readonly previewPairOpen: boolean;
  readonly collapsedEffortIds: ReadonlyArray<string>;

  readonly setEnabled: (enabled: boolean) => void;
  readonly setCursor: (cursor: number) => void;
  readonly stepForward: () => void;
  readonly stepBack: () => void;
  readonly reset: () => void;
  readonly dispatch: (event: FixtureUserEventInput) => void;
  readonly openThread: (threadId: string | null) => void;
  readonly setPanelOpen: (open: boolean) => void;
  readonly toggleSelected: (threadId: string) => void;
  readonly setSelected: (threadIds: ReadonlyArray<string>) => void;
  readonly clearSelection: () => void;
  readonly openCompare: (lens?: LensKind) => void;
  readonly closeCompare: () => void;
  readonly setLens: (lens: LensKind) => void;
  readonly setPreviewPairOpen: (open: boolean) => void;
  readonly toggleEffortCollapsed: (effortId: string) => void;
}

function readEnabled(): boolean {
  try {
    return (
      typeof window !== "undefined" && window.localStorage.getItem(ENABLED_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

function writeEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(ENABLED_STORAGE_KEY, "1");
    else window.localStorage.removeItem(ENABLED_STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the flag then lives for the session only.
  }
}

const LAST_STEP = FIXTURE_STEPS.length - 1;

function clampCursor(cursor: number): number {
  return Math.min(LAST_STEP, Math.max(0, Math.trunc(cursor)));
}

export const useOrchestrationFixtureStore = create<FixtureStore>((set, get) => ({
  enabled: readEnabled(),
  cursor: LAST_STEP,
  userEvents: [],
  openThreadId: COORDINATOR_ID,
  panelOpen: true,
  panelMode: "work",
  selectedThreadIds: [],
  lens: null,
  previewPairOpen: false,
  collapsedEffortIds: [],

  setEnabled: (enabled) => {
    writeEnabled(enabled);
    set({ enabled });
  },
  setCursor: (cursor) => set({ cursor: clampCursor(cursor) }),
  stepForward: () => set({ cursor: clampCursor(get().cursor + 1) }),
  stepBack: () => set({ cursor: clampCursor(get().cursor - 1) }),
  reset: () =>
    set({
      userEvents: [],
      cursor: LAST_STEP,
      selectedThreadIds: [],
      panelMode: "work",
      lens: null,
      previewPairOpen: false,
    }),
  dispatch: (input) => {
    const { cursor, userEvents } = get();
    const step = FIXTURE_STEPS[cursor];
    if (step === undefined) return;
    const priorAtStep = userEvents.filter((entry) => entry.stepIndex === cursor).length;
    const at = new Date(
      Date.parse(step.at) + (priorAtStep + 1) * USER_EVENT_SPACING_MS,
    ).toISOString();
    const event = { ...input, at } as FixtureEvent;
    set({ userEvents: [...userEvents, { stepIndex: cursor, event }] });
  },
  openThread: (threadId) => set({ openThreadId: threadId }),
  setPanelOpen: (open) => set({ panelOpen: open }),
  toggleSelected: (threadId) => {
    const { selectedThreadIds } = get();
    set({
      selectedThreadIds: selectedThreadIds.includes(threadId)
        ? selectedThreadIds.filter((id) => id !== threadId)
        : [...selectedThreadIds, threadId],
    });
  },
  setSelected: (threadIds) => set({ selectedThreadIds: [...threadIds] }),
  clearSelection: () =>
    set({ selectedThreadIds: [], panelMode: "work", lens: null, previewPairOpen: false }),
  openCompare: (lens) =>
    set({ panelMode: "compare", panelOpen: true, lens: lens ?? null, previewPairOpen: false }),
  closeCompare: () => set({ panelMode: "work", previewPairOpen: false }),
  setLens: (lens) => set({ lens, previewPairOpen: false }),
  setPreviewPairOpen: (open) => set({ previewPairOpen: open }),
  toggleEffortCollapsed: (effortId) => {
    const { collapsedEffortIds } = get();
    set({
      collapsedEffortIds: collapsedEffortIds.includes(effortId)
        ? collapsedEffortIds.filter((id) => id !== effortId)
        : [...collapsedEffortIds, effortId],
    });
  },
}));

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

let cachedInputs: { cursor: number; userEvents: ReadonlyArray<FixtureUserEvent> } | null = null;
let cachedState: FixtureState | null = null;

/** Reduced state for the cursor; memoized on the store inputs' identities. */
export function selectFixtureState(
  store: Pick<FixtureStore, "cursor" | "userEvents">,
): FixtureState {
  if (
    cachedState !== null &&
    cachedInputs !== null &&
    cachedInputs.cursor === store.cursor &&
    cachedInputs.userEvents === store.userEvents
  ) {
    return cachedState;
  }
  const events: FixtureEvent[] = [];
  for (let index = 0; index <= store.cursor; index += 1) {
    const step = FIXTURE_STEPS[index];
    if (step === undefined) continue;
    events.push(...step.events);
    for (const entry of store.userEvents) {
      if (entry.stepIndex === index) events.push(entry.event);
    }
  }
  cachedInputs = { cursor: store.cursor, userEvents: store.userEvents };
  cachedState = reduceFixtureEvents(events);
  return cachedState;
}

export function useFixtureState(): FixtureState {
  return useOrchestrationFixtureStore(selectFixtureState);
}

export function readFixtureState(): FixtureState {
  return selectFixtureState(useOrchestrationFixtureStore.getState());
}
