/**
 * Thread coordination read model shared by web and mobile.
 *
 * The shell snapshot carries `coordination` (relationships, efforts, waits, watches)
 * per environment. This module turns those facts into a lineage keyed by
 * scoped thread key plus the small selectors the sidebar, thread header and
 * Work panel need. Nothing here reads transcripts; ordinary threads with no
 * coordination produce no entries and cost nothing.
 */
import type {
  EnvironmentId,
  OrchestrationCoordinationShell,
  OrchestrationEffortShell,
  OrchestrationThreadRef,
  OrchestrationWaitShell,
  OrchestrationWatchShell,
  ScopedThreadRef,
  ThreadOrchestrationEffortId,
} from "@t3tools/contracts";

import { scopedThreadKey } from "../environment/scoped.ts";

export interface EnvironmentCoordination {
  readonly environmentId: EnvironmentId;
  readonly coordination: OrchestrationCoordinationShell;
}

export interface ThreadLineageEntry {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  /** The coordinator that created this thread; null for roots and forks. */
  readonly parentKey: string | null;
  /** The label the coordinator chose at creation, when any. */
  readonly label: string | null;
  readonly effortId: ThreadOrchestrationEffortId | null;
  readonly forkedFromKey: string | null;
  readonly replacesKey: string | null;
  readonly replacedByKey: string | null;
  /** Direct children in creation order. */
  readonly childKeys: ReadonlyArray<string>;
}

export interface ScopedEffort extends OrchestrationEffortShell {
  readonly environmentId: EnvironmentId;
  readonly coordinatorKey: string;
  readonly memberKeys: ReadonlyArray<string>;
}

export interface ScopedWait extends OrchestrationWaitShell {
  readonly environmentId: EnvironmentId;
  readonly coordinatorKey: string;
  readonly memberKeys: ReadonlyArray<string>;
}

export interface ScopedWatch extends OrchestrationWatchShell {
  readonly environmentId: EnvironmentId;
  readonly coordinatorKey: string;
}

export interface ThreadLineage {
  readonly entries: ReadonlyMap<string, ThreadLineageEntry>;
  readonly efforts: ReadonlyArray<ScopedEffort>;
  readonly waits: ReadonlyArray<ScopedWait>;
  readonly watches: ReadonlyArray<ScopedWatch>;
  readonly effortsByCoordinatorKey: ReadonlyMap<string, ReadonlyArray<ScopedEffort>>;
  readonly waitsByCoordinatorKey: ReadonlyMap<string, ReadonlyArray<ScopedWait>>;
  readonly watchesByCoordinatorKey: ReadonlyMap<string, ReadonlyArray<ScopedWatch>>;
}

export const EMPTY_THREAD_LINEAGE: ThreadLineage = Object.freeze({
  entries: new Map(),
  efforts: [],
  waits: [],
  watches: [],
  effortsByCoordinatorKey: new Map(),
  waitsByCoordinatorKey: new Map(),
  watchesByCoordinatorKey: new Map(),
});

/** A coordination ref without an environment belongs to the environment that carried it. */
export function resolveCoordinationRef(
  environmentId: EnvironmentId,
  ref: OrchestrationThreadRef,
): ScopedThreadRef {
  return { environmentId: ref.environmentId ?? environmentId, threadId: ref.threadId };
}

function coordinationRefKey(environmentId: EnvironmentId, ref: OrchestrationThreadRef): string {
  return scopedThreadKey(resolveCoordinationRef(environmentId, ref));
}

interface MutableEntry {
  key: string;
  ref: ScopedThreadRef;
  parentKey: string | null;
  parentCreatedAt: string | null;
  label: string | null;
  effortId: ThreadOrchestrationEffortId | null;
  forkedFromKey: string | null;
  replacesKey: string | null;
  replacedByKey: string | null;
  childKeys: string[];
}

export function buildThreadLineage(sources: ReadonlyArray<EnvironmentCoordination>): ThreadLineage {
  if (sources.every((source) => isEmptyCoordination(source.coordination))) {
    return EMPTY_THREAD_LINEAGE;
  }
  const entries = new Map<string, MutableEntry>();
  const entryFor = (environmentId: EnvironmentId, ref: OrchestrationThreadRef): MutableEntry => {
    const scoped = resolveCoordinationRef(environmentId, ref);
    const key = scopedThreadKey(scoped);
    const existing = entries.get(key);
    if (existing !== undefined) return existing;
    const created: MutableEntry = {
      key,
      ref: scoped,
      parentKey: null,
      parentCreatedAt: null,
      label: null,
      effortId: null,
      forkedFromKey: null,
      replacesKey: null,
      replacedByKey: null,
      childKeys: [],
    };
    entries.set(key, created);
    return created;
  };

  const efforts: ScopedEffort[] = [];
  const waits: ScopedWait[] = [];
  const watches: ScopedWatch[] = [];

  for (const { environmentId, coordination } of sources) {
    const relationships = [...coordination.relationships].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    for (const relationship of relationships) {
      const actor = entryFor(environmentId, relationship.actor);
      const target = entryFor(environmentId, relationship.target);
      if (actor.key === target.key) continue;
      switch (relationship.kind) {
        case "createdBy": {
          // The first creator wins; a later duplicate must not re-parent.
          if (target.parentKey !== null) break;
          target.parentKey = actor.key;
          target.parentCreatedAt = relationship.createdAt;
          target.label = relationship.label ?? null;
          target.effortId = relationship.effortId ?? null;
          actor.childKeys.push(target.key);
          break;
        }
        case "forkedFrom":
          // Actor is the fork's creator here as well; the target is the new thread.
          target.forkedFromKey = actor.key;
          break;
        case "replaces":
          // Actor supersedes target.
          actor.replacesKey = target.key;
          target.replacedByKey = actor.key;
          break;
      }
    }
    for (const effort of coordination.efforts) {
      const coordinatorKey = coordinationRefKey(environmentId, effort.coordinator);
      const memberKeys = effort.members.map((member) =>
        coordinationRefKey(environmentId, member.thread),
      );
      for (const member of effort.members) {
        const entry = entryFor(environmentId, member.thread);
        if (entry.effortId === null) entry.effortId = effort.effortId;
        if (entry.label === null) entry.label = member.label;
      }
      efforts.push({ ...effort, environmentId, coordinatorKey, memberKeys });
    }
    for (const wait of coordination.waits) {
      waits.push({
        ...wait,
        environmentId,
        coordinatorKey: coordinationRefKey(environmentId, wait.coordinator),
        memberKeys: wait.members.map((member) => coordinationRefKey(environmentId, member.thread)),
      });
    }
    for (const watch of coordination.watches) {
      watches.push({
        ...watch,
        environmentId,
        coordinatorKey: coordinationRefKey(environmentId, watch.coordinator),
      });
    }
  }

  // Drop cycles defensively: a thread can never be its own ancestor.
  for (const entry of entries.values()) {
    let cursor = entry.parentKey;
    let guard = 0;
    while (cursor !== null && guard < 64) {
      if (cursor === entry.key) {
        const parent = entries.get(entry.parentKey ?? "");
        if (parent !== undefined) {
          parent.childKeys = parent.childKeys.filter((key) => key !== entry.key);
        }
        entry.parentKey = null;
        break;
      }
      cursor = entries.get(cursor)?.parentKey ?? null;
      guard += 1;
    }
  }

  efforts.sort((left, right) => left.openedAt.localeCompare(right.openedAt));
  waits.sort((left, right) => left.openedAt.localeCompare(right.openedAt));
  watches.sort((left, right) => left.openedAt.localeCompare(right.openedAt));
  const frozen = new Map<string, ThreadLineageEntry>();
  for (const entry of entries.values()) {
    frozen.set(entry.key, {
      key: entry.key,
      ref: entry.ref,
      parentKey: entry.parentKey,
      label: entry.label,
      effortId: entry.effortId,
      forkedFromKey: entry.forkedFromKey,
      replacesKey: entry.replacesKey,
      replacedByKey: entry.replacedByKey,
      childKeys: entry.childKeys,
    });
  }
  return {
    entries: frozen,
    efforts,
    waits,
    watches,
    effortsByCoordinatorKey: groupBy(efforts, (effort) => effort.coordinatorKey),
    waitsByCoordinatorKey: groupBy(waits, (wait) => wait.coordinatorKey),
    watchesByCoordinatorKey: groupBy(watches, (watch) => watch.coordinatorKey),
  };
}

function isEmptyCoordination(coordination: OrchestrationCoordinationShell): boolean {
  return (
    coordination.relationships.length === 0 &&
    coordination.efforts.length === 0 &&
    coordination.waits.length === 0 &&
    coordination.watches.length === 0
  );
}

export function openWatchesOf(
  lineage: ThreadLineage,
  coordinatorKey: string,
): ReadonlyArray<ScopedWatch> {
  return (lineage.watchesByCoordinatorKey.get(coordinatorKey) ?? []).filter(
    (watch) => watch.state === "open",
  );
}

function groupBy<T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [item]);
    else bucket.push(item);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Sidebar layout
// ---------------------------------------------------------------------------

export interface SidebarLineageLayout {
  /** Threads that render under a parent instead of at the top level. */
  readonly nestedKeys: ReadonlySet<string>;
  /** Visible direct children per parent, in creation order. */
  readonly childrenByParentKey: ReadonlyMap<string, ReadonlyArray<string>>;
}

export const EMPTY_SIDEBAR_LINEAGE_LAYOUT: SidebarLineageLayout = Object.freeze({
  nestedKeys: new Set<string>(),
  childrenByParentKey: new Map(),
});

/**
 * Decides which visible threads nest. A child nests only while its parent is
 * itself visible (directly or nested), so a child whose parent was archived
 * or deleted stays a normal top-level row and never disappears.
 */
export function resolveSidebarLineage(
  lineage: ThreadLineage,
  visibleKeys: ReadonlySet<string>,
): SidebarLineageLayout {
  if (lineage.entries.size === 0) return EMPTY_SIDEBAR_LINEAGE_LAYOUT;
  const nested = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  // A visible parent is always placed somewhere (nested or top level), so a
  // child nests exactly when both it and its parent are visible.
  for (const entry of lineage.entries.values()) {
    if (entry.parentKey === null || !visibleKeys.has(entry.key)) continue;
    if (!visibleKeys.has(entry.parentKey)) continue;
    nested.add(entry.key);
    const siblings = childrenByParent.get(entry.parentKey);
    if (siblings === undefined) childrenByParent.set(entry.parentKey, [entry.key]);
    else siblings.push(entry.key);
  }
  if (nested.size === 0) return EMPTY_SIDEBAR_LINEAGE_LAYOUT;
  // Keep creation order as recorded on the parent entry.
  for (const [parentKey, keys] of childrenByParent) {
    const order = lineage.entries.get(parentKey)?.childKeys ?? [];
    keys.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  }
  return { nestedKeys: nested, childrenByParentKey: childrenByParent };
}

export interface LineageEffortGroup {
  /** Null for children that belong to no effort. */
  readonly effort: ScopedEffort | null;
  readonly memberKeys: ReadonlyArray<string>;
}

/** Splits a parent's children into effort groups in opening order, then the ungrouped rest. */
export function groupChildrenByEffort(
  lineage: ThreadLineage,
  parentKey: string,
  childKeys: ReadonlyArray<string>,
): ReadonlyArray<LineageEffortGroup> {
  const efforts = lineage.effortsByCoordinatorKey.get(parentKey) ?? [];
  const placed = new Set<string>();
  const groups: LineageEffortGroup[] = [];
  for (const effort of efforts) {
    const memberKeys = childKeys.filter((key) => {
      if (placed.has(key)) return false;
      const entry = lineage.entries.get(key);
      return effort.memberKeys.includes(key) || entry?.effortId === effort.effortId;
    });
    if (memberKeys.length === 0 && effort.closedAt !== null) continue;
    for (const key of memberKeys) placed.add(key);
    groups.push({ effort, memberKeys });
  }
  const ungrouped = childKeys.filter((key) => !placed.has(key));
  if (ungrouped.length > 0) groups.push({ effort: null, memberKeys: ungrouped });
  return groups;
}

// ---------------------------------------------------------------------------
// Participation, waits and roll-ups
// ---------------------------------------------------------------------------

export function threadParticipatesInCoordination(lineage: ThreadLineage, key: string): boolean {
  const entry = lineage.entries.get(key);
  if (entry !== undefined && (entry.parentKey !== null || entry.childKeys.length > 0)) return true;
  return (
    (lineage.effortsByCoordinatorKey.get(key)?.length ?? 0) > 0 ||
    (lineage.waitsByCoordinatorKey.get(key)?.length ?? 0) > 0 ||
    (lineage.watchesByCoordinatorKey.get(key)?.length ?? 0) > 0
  );
}

export function rootCoordinatorKey(lineage: ThreadLineage, key: string): string {
  let current = key;
  let guard = 0;
  while (guard < 64) {
    const parent = lineage.entries.get(current)?.parentKey;
    if (parent === null || parent === undefined) return current;
    current = parent;
    guard += 1;
  }
  return current;
}

export function lineageDepth(lineage: ThreadLineage, key: string): number {
  let depth = 0;
  let current = lineage.entries.get(key)?.parentKey ?? null;
  while (current !== null && depth < 64) {
    depth += 1;
    current = lineage.entries.get(current)?.parentKey ?? null;
  }
  return depth;
}

export function openWaitsOf(
  lineage: ThreadLineage,
  coordinatorKey: string,
): ReadonlyArray<ScopedWait> {
  return (lineage.waitsByCoordinatorKey.get(coordinatorKey) ?? []).filter(
    (wait) => wait.state === "open",
  );
}

/** Open waits anywhere that cover the thread, so a worker knows someone is waiting on it. */
export function openWaitsCovering(lineage: ThreadLineage, key: string): ReadonlyArray<ScopedWait> {
  return lineage.waits.filter((wait) => wait.state === "open" && wait.memberKeys.includes(key));
}

export type WorkerState = "working" | "blocked" | "completed" | "failed" | "stopped" | "idle";

export interface WorkerStateInput {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: string } | null;
  readonly latestTurn: { readonly state: string } | null;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
}

/** One honest state per worker, derived from the shell the sidebar already reads. */
export function resolveWorkerState(shell: WorkerStateInput): WorkerState {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "blocked";
  if (shell.session?.status === "running" || shell.session?.status === "starting") return "working";
  if (shell.session?.status === "error") return "failed";
  if (shell.backgroundLiveness === "working" || shell.backgroundLiveness === "monitoring") {
    return "working";
  }
  switch (shell.latestTurn?.state) {
    case "running":
      return "working";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "stopped";
    default:
      return "idle";
  }
}

export interface CoordinationCounts {
  readonly working: number;
  readonly blocked: number;
  readonly completed: number;
  readonly failed: number;
  readonly stopped: number;
  readonly idle: number;
  readonly total: number;
}

export const EMPTY_COORDINATION_COUNTS: CoordinationCounts = Object.freeze({
  working: 0,
  blocked: 0,
  completed: 0,
  failed: 0,
  stopped: 0,
  idle: 0,
  total: 0,
});

/** Counts workers by state; replaced threads are skipped so retries do not double count. */
export function countWorkers(
  lineage: ThreadLineage,
  keys: ReadonlyArray<string>,
  stateOf: (key: string) => WorkerState | null,
): CoordinationCounts {
  const counts = { working: 0, blocked: 0, completed: 0, failed: 0, stopped: 0, idle: 0, total: 0 };
  for (const key of keys) {
    if (lineage.entries.get(key)?.replacedByKey !== null && lineage.entries.has(key)) continue;
    const state = stateOf(key);
    if (state === null) continue;
    counts.total += 1;
    counts[state] += 1;
  }
  return counts;
}

/** Short phrase such as `2 working · 1 needs you · 3 done`; null when nothing is counted. */
export function coordinationCountsLabel(counts: CoordinationCounts): string | null {
  const parts: string[] = [];
  if (counts.working > 0) parts.push(`${counts.working} working`);
  if (counts.blocked > 0)
    parts.push(`${counts.blocked} need${counts.blocked === 1 ? "s" : ""} you`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.completed > 0) parts.push(`${counts.completed} done`);
  if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** All descendants in depth-first creation order. */
export function descendantKeys(lineage: ThreadLineage, key: string): ReadonlyArray<string> {
  const result: string[] = [];
  const visit = (current: string, depth: number) => {
    if (depth > 64) return;
    for (const child of lineage.entries.get(current)?.childKeys ?? []) {
      result.push(child);
      visit(child, depth + 1);
    }
  };
  visit(key, 0);
  return result;
}
