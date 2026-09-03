/**
 * Joins the store with the pure model: the simulated device, the work index,
 * and the effective expansion of every container (stored choice, device
 * default, or a temporary reveal for the selected hidden thread).
 */
import { useCallback, useMemo } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { buildIndex, placeThread, type ThreadPlacement, type WorkIndex } from "./model";
import { defaultExpanded, usePrototypeStore, type DeviceKind } from "./store";

export interface SidebarModel {
  readonly index: WorkIndex;
  readonly device: DeviceKind;
  /** True when the phone layout is forced on a wide screen and should sit in a frame. */
  readonly framed: boolean;
  readonly selectedId: string | null;
  readonly selectedThreadId: string | null;
  readonly selectedPlacement: ThreadPlacement | null;
  readonly isExpanded: (containerId: string) => boolean;
  readonly toggle: (containerId: string) => void;
}

export function selectedThreadIdOf(selectedId: string | null): string | null {
  return selectedId !== null && selectedId.startsWith("thread:") ? selectedId.slice(7) : null;
}

export function useSidebarModel(): SidebarModel {
  const threads = usePrototypeStore((s) => s.threads);
  const efforts = usePrototypeStore((s) => s.efforts);
  const selectedId = usePrototypeStore((s) => s.selectedId);
  const expansion = usePrototypeStore((s) => s.expansion);
  const dismissedReveals = usePrototypeStore((s) => s.dismissedReveals);
  const deviceChoice = usePrototypeStore((s) => s.device);
  const setExpanded = usePrototypeStore((s) => s.setExpanded);

  const narrow = useMediaQuery({ max: "md" });
  const device: DeviceKind =
    deviceChoice === "auto" ? (narrow ? "phone" : "desktop") : deviceChoice;
  const framed = device === "phone" && !narrow;

  const index = useMemo(() => buildIndex({ threads, efforts }), [threads, efforts]);
  const selectedThreadId = selectedThreadIdOf(selectedId);
  const selectedPlacement = useMemo(
    () => (selectedThreadId === null ? null : placeThread(index, selectedThreadId)),
    [index, selectedThreadId],
  );

  // The Settled shelf never auto-opens: a collapsed shelf shows just the
  // selected row, as the real sidebar does.
  const revealed = useMemo(() => {
    const set = new Set(
      (selectedPlacement?.containers ?? []).filter((id) => !id.startsWith("settled:")),
    );
    for (const id of dismissedReveals) set.delete(id);
    return set;
  }, [dismissedReveals, selectedPlacement]);

  const isExpanded = useCallback(
    (containerId: string) =>
      revealed.has(containerId) ||
      (expansion[device][containerId] ?? defaultExpanded(containerId, device)),
    [device, expansion, revealed],
  );
  const toggle = useCallback(
    (containerId: string) => setExpanded(device, containerId, !isExpanded(containerId)),
    [device, isExpanded, setExpanded],
  );

  return {
    index,
    device,
    framed,
    selectedId,
    selectedThreadId,
    selectedPlacement,
    isExpanded,
    toggle,
  };
}
