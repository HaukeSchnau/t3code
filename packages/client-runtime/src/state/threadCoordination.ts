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
  /** The coordinator that created this thread; null when no createdBy fact exists. */
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
          // The actor is the source thread. Creation ownership is a separate edge.
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
  const parentByChildKey = new Map<string, string>();
  for (const entry of lineage.entries.values()) {
    if (entry.parentKey !== null) parentByChildKey.set(entry.key, entry.parentKey);
  }

  // Explicit effort membership owns sidebar placement. This keeps a member in
  // its effort when its creation or fork source belongs to another lineage,
  // without rendering a second copy under that lineage. Open efforts win the
  // defensive tie-break when stale data puts one thread in multiple efforts.
  const placementEfforts = [...lineage.efforts].sort(
    (left, right) => Number(left.closedAt !== null) - Number(right.closedAt !== null),
  );
  const placedByEffort = new Set<string>();
  for (const effort of placementEfforts) {
    if (!visibleKeys.has(effort.coordinatorKey)) continue;
    for (const memberKey of effort.memberKeys) {
      if (
        placedByEffort.has(memberKey) ||
        memberKey === effort.coordinatorKey ||
        !visibleKeys.has(memberKey)
      ) {
        continue;
      }
      parentByChildKey.set(memberKey, effort.coordinatorKey);
      placedByEffort.add(memberKey);
    }
  }

  // Cross-lineage membership can otherwise form a display-only cycle even
  // when the durable createdBy graph is acyclic. Keep one participant at the
  // top level instead of recursing forever.
  for (const childKey of parentByChildKey.keys()) {
    const seen = new Set([childKey]);
    let cursor: string | undefined = parentByChildKey.get(childKey);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parentByChildKey.delete(childKey);
        break;
      }
      seen.add(cursor);
      cursor = parentByChildKey.get(cursor);
    }
  }

  const nested = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  // A visible parent is always placed somewhere (nested or top level), so a
  // child nests exactly when both it and its parent are visible.
  for (const entry of lineage.entries.values()) {
    const parentKey = parentByChildKey.get(entry.key);
    if (parentKey === undefined || !visibleKeys.has(entry.key)) continue;
    if (!visibleKeys.has(parentKey)) continue;
    nested.add(entry.key);
    const siblings = childrenByParent.get(parentKey);
    if (siblings === undefined) childrenByParent.set(parentKey, [entry.key]);
    else siblings.push(entry.key);
  }
  if (nested.size === 0) return EMPTY_SIDEBAR_LINEAGE_LAYOUT;
  // Keep creation order as recorded on the parent entry.
  for (const [parentKey, keys] of childrenByParent) {
    const order = [
      ...(lineage.entries.get(parentKey)?.childKeys ?? []),
      ...(lineage.effortsByCoordinatorKey.get(parentKey) ?? []).flatMap(
        (effort) => effort.memberKeys,
      ),
    ];
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

/** Current effort work stays ahead of completed and closed history. */
export function orderEffortGroups(
  lineage: ThreadLineage,
  groups: ReadonlyArray<LineageEffortGroup>,
  stateOf: (key: string) => WorkerState | null,
): ReadonlyArray<LineageEffortGroup> {
  const lifecycleRank = (group: LineageEffortGroup) => {
    const keys: string[] = [];
    const pending = group.memberKeys.toReversed();
    const seen = new Set<string>();
    while (pending.length > 0) {
      const key = pending.pop();
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      const children = lineage.entries.get(key)?.childKeys ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push(children[index]!);
      }
    }
    const counts = countWorkers(lineage, keys, stateOf);
    return effortLifecycleRank(group.effort, counts);
  };
  return groups
    .map((group, index) => ({ group, index, rank: lifecycleRank(group) }))
    .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ group }) => group);
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

/** Attention comes first so a narrow sidebar truncates less important counts. */
export function coordinationCountsLabel(
  counts: CoordinationCounts,
  options: { readonly hidden?: number } = {},
): string | null {
  const parts: string[] = [];
  const needsYou = counts.blocked + counts.failed;
  if (needsYou > 0) parts.push(`${needsYou} need${needsYou === 1 ? "s" : ""} you`);
  if (counts.working > 0) parts.push(`${counts.working} working`);
  if (counts.completed > 0) parts.push(`${counts.completed} done`);
  if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
  if (options.hidden !== undefined) parts.push(`${options.hidden} hidden`);
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

export interface SidebarOrchestrationThreadItem {
  readonly type: "thread";
  readonly key: string;
  readonly threadKey: string;
  readonly rootKey: string;
  readonly depth: number;
  readonly lineageContainer: {
    readonly id: string;
    readonly expanded: boolean;
    readonly summary: string;
    readonly attention: boolean;
    readonly root: boolean;
  } | null;
  readonly attemptsContainer: {
    readonly id: string;
    readonly expanded: boolean;
    readonly count: number;
  } | null;
}

export interface SidebarOrchestrationSectionItem {
  readonly type: "section";
  readonly key: string;
  readonly containerId: string;
  readonly rootKey: string;
  readonly depth: number;
  readonly title: string;
  readonly expanded: boolean;
  readonly summary: string | null;
  readonly attention: boolean;
  readonly muted: boolean;
  readonly closed: boolean;
}

export interface SidebarOrchestrationHistoryItem {
  readonly type: "history";
  readonly key: string;
  readonly rootKey: string;
  readonly depth: number;
  readonly title: string;
  readonly summary: string;
}

export interface SidebarOrchestrationViewingItem {
  readonly type: "viewing";
  readonly key: string;
  readonly depth: number;
  readonly rootKey: string;
  readonly threadKey: string;
  readonly containerIds: ReadonlyArray<string>;
}

export type SidebarOrchestrationItem =
  | SidebarOrchestrationThreadItem
  | SidebarOrchestrationSectionItem
  | SidebarOrchestrationHistoryItem
  | SidebarOrchestrationViewingItem;

export interface SidebarOrchestrationItems {
  readonly items: ReadonlyArray<SidebarOrchestrationItem>;
  readonly placedThreadKeys: ReadonlySet<string>;
}

interface SidebarThreadNode {
  readonly key: string;
  readonly rootKey: string;
  readonly depth: number;
  readonly attempts: ReadonlyArray<SidebarThreadNode>;
  readonly groups: ReadonlyArray<SidebarGroupNode>;
  readonly history: ReadonlyArray<SidebarHistoryNode>;
  readonly descendants: SidebarTreeStats;
  readonly subtree: SidebarTreeStats;
}

interface SidebarGroupNode {
  readonly effort: ScopedEffort | null;
  readonly containerId: string | null;
  readonly title: string | null;
  readonly closed: boolean;
  readonly children: ReadonlyArray<SidebarThreadNode>;
  readonly subtree: SidebarTreeStats;
}

interface SidebarHistoryNode {
  readonly effort: ScopedEffort;
  readonly summary: string;
  readonly children: ReadonlyArray<SidebarThreadNode>;
}

interface SidebarTreeStats {
  readonly rows: number;
  readonly counts: CoordinationCounts;
}

interface SidebarContainerPath {
  readonly containerId: string;
  readonly parent: SidebarContainerPath | null;
}

function containerPathIds(path: SidebarContainerPath | null): ReadonlyArray<string> {
  const ids: string[] = [];
  for (let current = path; current !== null; current = current.parent) {
    ids.push(current.containerId);
  }
  ids.reverse();
  return ids;
}

const EMPTY_SIDEBAR_TREE_STATS: SidebarTreeStats = {
  rows: 0,
  counts: EMPTY_COORDINATION_COUNTS,
};

function mergeSidebarTreeStats(stats: ReadonlyArray<SidebarTreeStats>): SidebarTreeStats {
  if (stats.length === 0) return EMPTY_SIDEBAR_TREE_STATS;
  const counts = { working: 0, blocked: 0, completed: 0, failed: 0, stopped: 0, idle: 0, total: 0 };
  let rows = 0;
  for (const stat of stats) {
    rows += stat.rows;
    counts.working += stat.counts.working;
    counts.blocked += stat.counts.blocked;
    counts.completed += stat.counts.completed;
    counts.failed += stat.counts.failed;
    counts.stopped += stat.counts.stopped;
    counts.idle += stat.counts.idle;
    counts.total += stat.counts.total;
  }
  return { rows, counts };
}

function sidebarThreadOwnStats(
  lineage: ThreadLineage,
  key: string,
  stateOf: (threadKey: string) => WorkerState | null,
): SidebarTreeStats {
  const state = lineage.entries.get(key)?.replacedByKey == null ? stateOf(key) : null;
  if (state === null) return { rows: 1, counts: EMPTY_COORDINATION_COUNTS };
  return {
    rows: 1,
    counts: { ...EMPTY_COORDINATION_COUNTS, [state]: 1, total: 1 },
  };
}

function effortLifecycleRank(effort: ScopedEffort | null, counts: CoordinationCounts): number {
  if (counts.blocked + counts.failed > 0) return 0;
  if (counts.working > 0) return 1;
  if (counts.idle > 0) return 2;
  if (counts.total > 0 && counts.completed + counts.stopped === counts.total) return 3;
  return effort !== null && effort.closedAt !== null ? 4 : 2;
}

function replacementRoot(lineage: ThreadLineage, key: string) {
  let current = key;
  const seen = new Set([key]);
  while (seen.size < 64) {
    const next = lineage.entries.get(current)?.replacedByKey;
    if (next === null || next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
}

/**
 * Builds the canonical expandable sidebar tree from real coordination facts.
 * Lifecycle shelves stay outside this function. Callers pass only the thread
 * keys that belong in the live inbox, in their desired top-level order.
 */
export function buildSidebarOrchestrationItems(input: {
  readonly lineage: ThreadLineage;
  readonly orderedThreadKeys: ReadonlyArray<string>;
  readonly selectedThreadKey?: string | null;
  readonly isExpanded: (containerId: string) => boolean;
  readonly stateOf: (threadKey: string) => WorkerState | null;
  readonly isPinned?: (threadKey: string) => boolean;
}): SidebarOrchestrationItems {
  if (input.orderedThreadKeys.length === 0) {
    return { items: [], placedThreadKeys: new Set() };
  }
  const visible = new Set(input.orderedThreadKeys);
  const layout = resolveSidebarLineage(input.lineage, visible);
  const displayParentByKey = new Map<string, string>();
  const displayChildrenByParentKey = new Map<string, string[]>();
  for (const [parentKey, childKeys] of layout.childrenByParentKey) {
    for (const childKey of childKeys) {
      if ((input.isPinned?.(childKey) ?? false) !== (input.isPinned?.(parentKey) ?? false))
        continue;
      displayParentByKey.set(childKey, parentKey);
      const children = displayChildrenByParentKey.get(parentKey);
      if (children === undefined) displayChildrenByParentKey.set(parentKey, [childKey]);
      else children.push(childKey);
    }
  }
  const currentKeys = new Set(
    input.orderedThreadKeys.filter((key) => replacementRoot(input.lineage, key) === key),
  );
  const attemptsByKey = new Map<string, string[]>();
  for (const key of currentKeys) {
    const attempts: string[] = [];
    const seen = new Set([key]);
    let cursor = input.lineage.entries.get(key)?.replacesKey;
    while (cursor !== null && cursor !== undefined && visible.has(cursor) && !seen.has(cursor)) {
      attempts.push(cursor);
      seen.add(cursor);
      cursor = input.lineage.entries.get(cursor)?.replacesKey;
    }
    if (attempts.length > 0) attemptsByKey.set(key, attempts);
  }

  const placedThreadKeys = new Set<string>();
  const placementState: {
    selected: { rootKey: string; path: ReadonlyArray<string> } | null;
  } = { selected: null };
  const building = new Set<string>();
  const makeNode = (
    key: string,
    rootKey: string,
    depth: number,
    path: SidebarContainerPath | null,
  ): SidebarThreadNode => {
    placedThreadKeys.add(key);
    if (key === input.selectedThreadKey) {
      placementState.selected = { rootKey, path: containerPathIds(path) };
    }
    if (building.has(key)) {
      return {
        key,
        rootKey,
        depth,
        attempts: [],
        groups: [],
        history: [],
        descendants: EMPTY_SIDEBAR_TREE_STATS,
        subtree: sidebarThreadOwnStats(input.lineage, key, input.stateOf),
      };
    }
    building.add(key);
    const lineageContainerId = `lineage:${key}`;
    const childPath = { containerId: lineageContainerId, parent: path };
    const rawChildren = displayChildrenByParentKey.get(key) ?? [];
    const childKeys = rawChildren.filter((childKey) => currentKeys.has(childKey));
    const grouped = groupChildrenByEffort(input.lineage, key, childKeys);
    const hasEfforts = (input.lineage.effortsByCoordinatorKey.get(key)?.length ?? 0) > 0;
    const groups: SidebarGroupNode[] = [];
    for (const group of grouped) {
      if (
        group.effort !== null &&
        group.effort.closedAt !== null &&
        group.memberKeys.length === 0
      ) {
        continue;
      }
      const containerId =
        group.effort === null
          ? hasEfforts
            ? `unassigned:${key}`
            : null
          : `effort:${group.effort.effortId}`;
      const groupPath: SidebarContainerPath =
        containerId === null ? childPath : { containerId, parent: childPath };
      const children = group.memberKeys.map((childKey) =>
        makeNode(childKey, rootKey, depth + 1, groupPath),
      );
      groups.push({
        effort: group.effort,
        containerId,
        title:
          group.effort === null ? (hasEfforts ? "Other delegated work" : null) : group.effort.title,
        closed: group.effort !== null && group.effort.closedAt !== null,
        children,
        subtree: mergeSidebarTreeStats(children.map((child) => child.subtree)),
      });
    }
    groups.sort(
      (left, right) =>
        effortLifecycleRank(left.effort, left.subtree.counts) -
        effortLifecycleRank(right.effort, right.subtree.counts),
    );
    const currentEffortIds = new Set(
      groups.flatMap((group) => (group.effort === null ? [] : [group.effort.effortId])),
    );
    const closedEfforts = (input.lineage.effortsByCoordinatorKey.get(key) ?? []).filter(
      (effort) => effort.closedAt !== null && !currentEffortIds.has(effort.effortId),
    );
    const history: SidebarHistoryNode[] = closedEfforts.map((effort) => {
      const counts = countWorkers(input.lineage, effort.memberKeys, input.stateOf);
      return {
        effort,
        summary:
          coordinationCountsLabel(counts) ??
          `${effort.memberKeys.length} thread${effort.memberKeys.length === 1 ? "" : "s"}`,
        children: [],
      };
    });
    const attempts = (attemptsByKey.get(key) ?? []).map((attemptKey) =>
      makeNode(attemptKey, rootKey, depth + 1, {
        containerId: `attempts:${key}`,
        parent: childPath,
      }),
    );
    const descendants = mergeSidebarTreeStats([
      ...attempts.map((attempt) => attempt.subtree),
      ...groups.map((group) => group.subtree),
      ...history.flatMap((entry) => entry.children.map((child) => child.subtree)),
    ]);
    building.delete(key);
    return {
      key,
      rootKey,
      depth,
      attempts,
      groups,
      history,
      descendants,
      subtree: mergeSidebarTreeStats([
        sidebarThreadOwnStats(input.lineage, key, input.stateOf),
        descendants,
      ]),
    };
  };

  const roots = input.orderedThreadKeys
    .filter((key) => currentKeys.has(key) && !displayParentByKey.has(key))
    .map((key) => makeNode(key, key, 0, null));

  const items: SidebarOrchestrationItem[] = [];
  const emitNode = (node: SidebarThreadNode) => {
    const lineageContainerId = `lineage:${node.key}`;
    const hasLineage = node.descendants.rows > 0 || node.history.length > 0;
    const counts = node.descendants.counts;
    const attemptsContainerId = `attempts:${node.key}`;
    items.push({
      type: "thread",
      key: `thread:${node.key}`,
      threadKey: node.key,
      rootKey: node.rootKey,
      depth: node.depth,
      lineageContainer: hasLineage
        ? {
            id: lineageContainerId,
            expanded: input.isExpanded(lineageContainerId),
            summary:
              coordinationCountsLabel(counts, { hidden: node.descendants.rows }) ?? "0 hidden",
            attention: counts.blocked + counts.failed > 0,
            root: node.depth === 0,
          }
        : null,
      attemptsContainer:
        node.attempts.length > 0
          ? {
              id: attemptsContainerId,
              expanded: input.isExpanded(attemptsContainerId),
              count: node.attempts.length,
            }
          : null,
    });
    if (!hasLineage || !input.isExpanded(lineageContainerId)) return;
    if (node.attempts.length > 0 && input.isExpanded(attemptsContainerId)) {
      for (const attempt of node.attempts) emitNode(attempt);
    }
    for (const group of node.groups) {
      if (group.containerId !== null && group.title !== null) {
        const groupCounts = group.subtree.counts;
        const expanded = input.isExpanded(group.containerId);
        items.push({
          type: "section",
          key: `section:${group.containerId}`,
          containerId: group.containerId,
          rootKey: node.rootKey,
          depth: node.depth + 1,
          title: group.title,
          expanded,
          summary:
            expanded && !group.closed
              ? null
              : (coordinationCountsLabel(groupCounts, { hidden: group.subtree.rows }) ?? null),
          attention: groupCounts.blocked + groupCounts.failed > 0,
          muted: false,
          closed: group.closed,
        });
        if (!expanded) continue;
      }
      for (const child of group.children) emitNode(child);
    }
    if (node.history.length === 0) return;
    const historyContainerId = `history:${node.key}`;
    const historyExpanded = input.isExpanded(historyContainerId);
    items.push({
      type: "section",
      key: `section:${historyContainerId}`,
      containerId: historyContainerId,
      rootKey: node.rootKey,
      depth: node.depth + 1,
      title: "Past efforts",
      expanded: historyExpanded,
      summary: historyExpanded ? null : String(node.history.length),
      attention: false,
      muted: true,
      closed: false,
    });
    if (historyExpanded) {
      for (const history of node.history) {
        items.push({
          type: "history",
          key: `history:${history.effort.effortId}`,
          rootKey: node.rootKey,
          depth: node.depth + 2,
          title: history.effort.title,
          summary: history.summary,
        });
        for (const child of history.children) emitNode(child);
      }
    }
  };

  const selectedThreadKey = input.selectedThreadKey ?? null;
  for (const root of roots) {
    const start = items.length;
    emitNode(root);
    const placement = selectedThreadKey === null ? null : placementState.selected;
    if (
      selectedThreadKey !== null &&
      placement?.rootKey === root.key &&
      placement.path.some((containerId) => !input.isExpanded(containerId))
    ) {
      items.splice(start + 1, 0, {
        type: "viewing",
        key: `viewing:${selectedThreadKey}`,
        depth: 1,
        rootKey: root.key,
        threadKey: selectedThreadKey,
        containerIds: placement.path,
      });
    }
  }
  return { items, placedThreadKeys };
}
