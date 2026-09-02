/**
 * Thread coordination atoms: the lineage derived from every environment's
 * shell `coordination`, plus per-thread selectors for the sidebar, the thread
 * header strip and the Work panel.
 *
 * Reads the same snapshot atoms the thread shells use, so the dev fixture's
 * virtual environment flows through here unchanged.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  buildThreadLineage,
  EMPTY_THREAD_LINEAGE,
  resolveSidebarLineage,
  threadParticipatesInCoordination,
  type EnvironmentCoordination,
  type SidebarLineageLayout,
  type ThreadLineage,
  type ThreadLineageEntry,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentSnapshotAtom } from "./shell";
import { useThreadShells } from "./entities";
import { threadCatalogValueAtom } from "./threads";

const EMPTY_SOURCES: ReadonlyArray<EnvironmentCoordination> = Object.freeze([]);

const coordinationSourceAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): EnvironmentCoordination | null => {
    const coordination = get(environmentSnapshotAtom(environmentId))?.coordination;
    return coordination === undefined ? null : { environmentId, coordination };
  }).pipe(Atom.withLabel(`environment-coordination:${environmentId}`)),
);

let previousSources: ReadonlyArray<EnvironmentCoordination> = EMPTY_SOURCES;
const coordinationSourcesAtom = Atom.make((get) => {
  const next: EnvironmentCoordination[] = [];
  for (const environmentId of get(threadCatalogValueAtom).entries.keys()) {
    const source = get(coordinationSourceAtom(environmentId));
    if (source !== null) next.push(source);
  }
  if (
    next.length === previousSources.length &&
    next.every((source, index) => source.coordination === previousSources[index]?.coordination)
  ) {
    return previousSources;
  }
  previousSources = next;
  return next;
}).pipe(Atom.withLabel("environment-coordination-sources"));

export const threadLineageAtom = Atom.make((get): ThreadLineage => {
  const sources = get(coordinationSourcesAtom);
  return sources.length === 0 ? EMPTY_THREAD_LINEAGE : buildThreadLineage(sources);
}).pipe(Atom.withLabel("thread-lineage"));

export function useThreadLineage(): ThreadLineage {
  return useAtomValue(threadLineageAtom);
}

export function useThreadLineageEntry(ref: ScopedThreadRef | null): ThreadLineageEntry | null {
  const lineage = useThreadLineage();
  return ref === null ? null : (lineage.entries.get(scopedThreadKey(ref)) ?? null);
}

/** True when the thread has a parent, children, efforts or waits; ordinary threads say no. */
export function useThreadCoordinates(ref: ScopedThreadRef | null): boolean {
  const lineage = useThreadLineage();
  return ref !== null && threadParticipatesInCoordination(lineage, scopedThreadKey(ref));
}

/** Sidebar nesting over the currently known, non-archived thread shells. */
export function useSidebarLineageLayout(): SidebarLineageLayout {
  const lineage = useThreadLineage();
  const threads = useThreadShells();
  return useMemo(() => {
    if (lineage.entries.size === 0) return resolveSidebarLineage(lineage, new Set());
    const visible = new Set<string>();
    for (const thread of threads) {
      if (thread.archivedAt === null) {
        visible.add(scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id }));
      }
    }
    return resolveSidebarLineage(lineage, visible);
  }, [lineage, threads]);
}
