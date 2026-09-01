import { create } from "zustand";

import type { DelegationPhase } from "./fixtureData";

interface DelegationFixtureStore {
  readonly phase: DelegationPhase;
  readonly setPhase: (phase: DelegationPhase) => void;
}

/** Shared only so the real sidebar and the fixture transcript change state together. */
export const useDelegationFixtureStore = create<DelegationFixtureStore>((set) => ({
  phase: "launched",
  setPhase: (phase) => set({ phase }),
}));
