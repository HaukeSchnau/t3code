import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadFindScope } from "@t3tools/client-runtime/thread-find";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

type ThreadFindOption = "caseSensitive" | "wholeWord" | "regex";

/** A thread search hit that find selects once its thread is open. */
export interface ThreadFindHit {
  readonly threadKey: string;
  readonly messageId: MessageId;
}

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
  readonly hit: ThreadFindHit | null;
  /** The sidebar takes this query into its thread search, then clears it. */
  readonly searchAllRequest: { readonly query: string } | null;
  readonly openFind: (query?: string) => void;
  /**
   * Opens find on a thread search hit. Thread search matches literal text in
   * any role, so options that could hide the hit are reset.
   */
  readonly openFindAtHit: (threadRef: ScopedThreadRef, messageId: MessageId, query: string) => void;
  readonly clearHit: () => void;
  readonly closeFind: () => void;
  readonly setQuery: (query: string) => void;
  readonly toggleOption: (option: ThreadFindOption) => void;
  readonly setScope: (scope: ThreadFindScope) => void;
  readonly toggleList: () => void;
  readonly searchAllThreads: () => void;
  readonly clearSearchAllRequest: () => void;
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
  hit: null,
  searchAllRequest: null,
  openFind: (query) =>
    set((state) => ({
      open: true,
      query: query ?? state.query,
      focusRequest: state.focusRequest + 1,
    })),
  openFindAtHit: (threadRef, messageId, query) =>
    set((state) => ({
      open: true,
      query,
      wholeWord: false,
      regex: false,
      scope: "all",
      hit: { threadKey: scopedThreadKey(threadRef), messageId },
      focusRequest: state.focusRequest + 1,
    })),
  clearHit: () => set({ hit: null }),
  closeFind: () => set({ open: false, listOpen: false, hit: null }),
  setQuery: (query) => set({ query, hit: null }),
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
  searchAllThreads: () => set((state) => ({ searchAllRequest: { query: state.query } })),
  clearSearchAllRequest: () => set({ searchAllRequest: null }),
}));
