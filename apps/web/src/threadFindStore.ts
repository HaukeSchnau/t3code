import type { ThreadFindScope } from "@t3tools/client-runtime/thread-find";
import { create } from "zustand";

type ThreadFindOption = "caseSensitive" | "wholeWord" | "regex";

/**
 * Find in the open thread. One store for every thread, so the query carries
 * over when the reader switches threads and re-runs there.
 */
interface ThreadFindState {
  readonly open: boolean;
  readonly listOpen: boolean;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
  readonly scope: ThreadFindScope;
  /** Bumped whenever the input should take focus and select its text. */
  readonly focusRequest: number;
  readonly openFind: (query?: string) => void;
  readonly closeFind: () => void;
  readonly setQuery: (query: string) => void;
  readonly toggleOption: (option: ThreadFindOption) => void;
  readonly setScope: (scope: ThreadFindScope) => void;
  readonly toggleList: () => void;
}

export const useThreadFindStore = create<ThreadFindState>()((set) => ({
  open: false,
  listOpen: false,
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: "all",
  focusRequest: 0,
  openFind: (query) =>
    set((state) => ({
      open: true,
      query: query ?? state.query,
      focusRequest: state.focusRequest + 1,
    })),
  closeFind: () => set({ open: false, listOpen: false }),
  setQuery: (query) => set({ query }),
  toggleOption: (option) =>
    set((state) =>
      option === "caseSensitive"
        ? { caseSensitive: !state.caseSensitive }
        : option === "wholeWord"
          ? { wholeWord: !state.wholeWord }
          : { regex: !state.regex },
    ),
  setScope: (scope) => set({ scope }),
  toggleList: () => set((state) => ({ listOpen: !state.listOpen })),
}));
