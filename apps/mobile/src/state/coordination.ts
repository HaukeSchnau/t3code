import { useAtomValue } from "@effect/atom-react";
import {
  buildThreadLineage,
  EMPTY_THREAD_LINEAGE,
  type EnvironmentCoordination,
  type ThreadLineage,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentSnapshotAtom } from "./shell";

const EMPTY_SOURCES: ReadonlyArray<EnvironmentCoordination> = Object.freeze([]);

const coordinationSourceAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): EnvironmentCoordination | null => {
    const coordination = get(environmentSnapshotAtom(environmentId))?.coordination;
    return coordination === undefined ? null : { environmentId, coordination };
  }).pipe(Atom.withLabel(`mobile-environment-coordination:${environmentId}`)),
);

let previousSources: ReadonlyArray<EnvironmentCoordination> = EMPTY_SOURCES;
const coordinationSourcesAtom = Atom.make((get) => {
  const next: EnvironmentCoordination[] = [];
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
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
}).pipe(Atom.withLabel("mobile-environment-coordination-sources"));

const threadLineageAtom = Atom.make((get): ThreadLineage => {
  const sources = get(coordinationSourcesAtom);
  return sources.length === 0 ? EMPTY_THREAD_LINEAGE : buildThreadLineage(sources);
}).pipe(Atom.withLabel("mobile-thread-lineage"));

export function useThreadLineage(): ThreadLineage {
  return useAtomValue(threadLineageAtom);
}
