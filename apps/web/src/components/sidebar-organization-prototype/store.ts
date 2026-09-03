/**
 * Prototype state. Expansion preferences persist per simulated device against
 * stable container ids; everything else is session state so a reload resets
 * the demo but not what the reviewer has chosen to keep open.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { SAMPLE, type ProtoEffort, type ProtoThread } from "./data";

export type DeviceKind = "desktop" | "phone";
export type DeviceChoice = "auto" | DeviceKind;
export type ThemeChoice = "system" | "light" | "dark";

interface PrototypeState {
  readonly threads: ReadonlyArray<ProtoThread>;
  readonly efforts: ReadonlyArray<ProtoEffort>;
  /** `thread:<id>` or `effort:<id>`; the thing the main area shows. */
  readonly selectedId: string | null;
  readonly device: DeviceChoice;
  readonly theme: ThemeChoice;
  /** Stored expansion choices, keyed by device then container id. */
  readonly expansion: Record<DeviceKind, Record<string, boolean>>;
  /** Containers explicitly collapsed while the selected thread was inside them. */
  readonly dismissedReveals: ReadonlyArray<string>;
  readonly searchQuery: string;

  readonly select: (id: string | null) => void;
  readonly setExpanded: (device: DeviceKind, containerId: string, expanded: boolean) => void;
  readonly setDevice: (device: DeviceChoice) => void;
  readonly setTheme: (theme: ThemeChoice) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly updateThread: (id: string, patch: Partial<ProtoThread>) => void;
  readonly updateEffort: (id: string, patch: Partial<ProtoEffort>) => void;
  readonly addThread: (thread: ProtoThread, afterId: string) => void;
  readonly reset: () => void;
}

const EMPTY_EXPANSION: Record<DeviceKind, Record<string, boolean>> = { desktop: {}, phone: {} };

function sampleState() {
  return {
    threads: SAMPLE.threads,
    efforts: SAMPLE.efforts,
    selectedId: null,
    dismissedReveals: [],
    searchQuery: "",
  };
}

export const usePrototypeStore = create<PrototypeState>()(
  persist(
    (set) => ({
      ...sampleState(),
      device: "auto",
      theme: "system",
      expansion: EMPTY_EXPANSION,

      select: (id) => set({ selectedId: id, dismissedReveals: [], searchQuery: "" }),
      setExpanded: (device, containerId, expanded) =>
        set((state) => ({
          expansion: {
            ...state.expansion,
            [device]: { ...state.expansion[device], [containerId]: expanded },
          },
          dismissedReveals: expanded
            ? state.dismissedReveals.filter((id) => id !== containerId)
            : [...state.dismissedReveals, containerId],
        })),
      setDevice: (device) => set({ device }),
      setTheme: (theme) => set({ theme }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      updateThread: (id, patch) =>
        set((state) => ({
          threads: state.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),
      updateEffort: (id, patch) =>
        set((state) => ({
          efforts: state.efforts.map((e) => (e.id === id ? { ...e, ...patch } : e)),
        })),
      addThread: (thread, afterId) =>
        set((state) => {
          const at = state.threads.findIndex((t) => t.id === afterId);
          const threads = [...state.threads];
          threads.splice(at < 0 ? threads.length : at + 1, 0, thread);
          return { threads };
        }),
      reset: () =>
        set({
          ...sampleState(),
          device: "auto",
          theme: "system",
          expansion: EMPTY_EXPANSION,
        }),
    }),
    {
      name: "t3code:prototype:sidebar-organization:v2",
      partialize: (state) => ({
        expansion: state.expansion,
        device: state.device,
        theme: state.theme,
      }),
      merge: (persisted, current) => {
        const stored = persisted as Partial<Pick<PrototypeState, "expansion" | "device" | "theme">>;
        return {
          ...current,
          ...sampleState(),
          expansion: stored.expansion ?? current.expansion,
          device: stored.device ?? current.device,
          theme: stored.theme ?? current.theme,
        };
      },
    },
  ),
);

/**
 * Defaults before the user has chosen: project groups open everywhere, desktop
 * opens current delegated work, the phone keeps it folded, and history stays
 * closed on both.
 */
export function defaultExpanded(containerId: string, device: DeviceKind): boolean {
  if (containerId.startsWith("project:")) return true;
  if (containerId.startsWith("past:") || containerId.startsWith("attempts:")) return false;
  if (containerId.startsWith("settled:")) return false;
  return device === "desktop";
}
