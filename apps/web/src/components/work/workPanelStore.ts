/**
 * Presentation state for the Work panel: which workers are selected for
 * Compare and which lens is showing. Selection is keyed by scoped thread key
 * and cleared when the user leaves Compare; nothing here is durable.
 */
import { create } from "zustand";

export type CompareLens = "answer" | "diff" | "files" | "preview" | "terminal";

interface WorkPanelStore {
  readonly selectedKeys: ReadonlyArray<string>;
  readonly compareOpen: boolean;
  readonly lens: CompareLens | null;
  readonly collapsedEffortIds: ReadonlyArray<string>;
  readonly toggleSelected: (key: string) => void;
  readonly setSelected: (keys: ReadonlyArray<string>) => void;
  readonly clearSelection: () => void;
  readonly openCompare: () => void;
  readonly closeCompare: () => void;
  readonly setLens: (lens: CompareLens) => void;
  readonly toggleEffortCollapsed: (effortId: string) => void;
}

export const useWorkPanelStore = create<WorkPanelStore>((set, get) => ({
  selectedKeys: [],
  compareOpen: false,
  lens: null,
  collapsedEffortIds: [],
  toggleSelected: (key) => {
    const { selectedKeys } = get();
    set({
      selectedKeys: selectedKeys.includes(key)
        ? selectedKeys.filter((entry) => entry !== key)
        : [...selectedKeys, key],
    });
  },
  setSelected: (keys) => set({ selectedKeys: [...keys] }),
  clearSelection: () => set({ selectedKeys: [], compareOpen: false, lens: null }),
  openCompare: () => set({ compareOpen: true }),
  closeCompare: () => set({ compareOpen: false }),
  setLens: (lens) => set({ lens }),
  toggleEffortCollapsed: (effortId) => {
    const { collapsedEffortIds } = get();
    set({
      collapsedEffortIds: collapsedEffortIds.includes(effortId)
        ? collapsedEffortIds.filter((entry) => entry !== effortId)
        : [...collapsedEffortIds, effortId],
    });
  },
}));
