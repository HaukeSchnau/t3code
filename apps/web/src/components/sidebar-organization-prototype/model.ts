/**
 * Pure derivations for the prototype sidebar: which threads sit where, what a
 * coordinator's tray contains, recursive work counts, and the chain of
 * collapsible containers between the top level and any thread.
 *
 * Container ids are stable strings built from coordinator and effort ids so
 * expansion preferences can be stored against them:
 *   `tray:<coordinatorId>`, `effort:<effortId>`, `other:<coordinatorId>`,
 *   `past:<coordinatorId>`, `attempts:<threadId>`, `settled`.
 */
import type { ProtoEffort, ProtoThread, Scenario } from "./data";

export interface WorkIndex {
  readonly byId: ReadonlyMap<string, ProtoThread>;
  readonly childrenOf: ReadonlyMap<string, ReadonlyArray<ProtoThread>>;
  readonly effortsOf: ReadonlyMap<string, ReadonlyArray<ProtoEffort>>;
  readonly effortById: ReadonlyMap<string, ProtoEffort>;
  readonly replacedBy: ReadonlyMap<string, ProtoThread>;
}

export function buildIndex(scenario: Pick<Scenario, "threads" | "efforts">): WorkIndex {
  const byId = new Map<string, ProtoThread>();
  const childrenOf = new Map<string, ProtoThread[]>();
  const replacedBy = new Map<string, ProtoThread>();
  for (const t of scenario.threads) {
    byId.set(t.id, t);
    if (t.parentId !== null) {
      const list = childrenOf.get(t.parentId) ?? [];
      list.push(t);
      childrenOf.set(t.parentId, list);
    }
    if (t.replacesId !== null) replacedBy.set(t.replacesId, t);
  }
  const effortsOf = new Map<string, ProtoEffort[]>();
  const effortById = new Map<string, ProtoEffort>();
  for (const e of scenario.efforts) {
    effortById.set(e.id, e);
    const list = effortsOf.get(e.coordinatorId) ?? [];
    list.push(e);
    effortsOf.set(e.coordinatorId, list);
  }
  return { byId, childrenOf, effortsOf, effortById, replacedBy };
}

export function isSuperseded(index: WorkIndex, thread: ProtoThread): boolean {
  return index.replacedBy.has(thread.id);
}

/** Current work: not settled and not replaced by a later attempt. */
export function isCurrent(index: WorkIndex, thread: ProtoThread): boolean {
  return !thread.settled && !isSuperseded(index, thread);
}

export function isCoordinator(index: WorkIndex, threadId: string): boolean {
  return (index.childrenOf.get(threadId)?.length ?? 0) > 0;
}

export function effortMembers(index: WorkIndex, effort: ProtoEffort): ReadonlyArray<ProtoThread> {
  return (index.childrenOf.get(effort.coordinatorId) ?? []).filter((t) => t.effortId === effort.id);
}

/** A closed effort stays in current work while any member is still current. */
export function isEffortCurrent(index: WorkIndex, effort: ProtoEffort): boolean {
  return !effort.closed || effortMembers(index, effort).some((t) => isCurrent(index, t));
}

export interface WorkCounts {
  readonly working: number;
  readonly needsYou: number;
  readonly done: number;
}

/**
 * Recursive counts over current descendants. Needs-you is blocked threads
 * plus failures nobody has retried yet. Superseded and settled threads are
 * skipped so retries and history do not double count.
 */
export function countWork(index: WorkIndex, rootIds: ReadonlyArray<string>): WorkCounts {
  let working = 0;
  let needsYou = 0;
  let done = 0;
  const visit = (id: string, depth: number) => {
    if (depth > 32) return;
    for (const child of index.childrenOf.get(id) ?? []) {
      if (!isCurrent(index, child)) continue;
      if (child.state === "working") working += 1;
      else if (child.state === "blocked" || child.state === "failed") needsYou += 1;
      else if (child.state === "completed") done += 1;
      visit(child.id, depth + 1);
    }
  };
  for (const id of rootIds) visit(id, 0);
  return { working, needsYou, done };
}

/** Counts for an explicit member list plus everything below those members. */
export function countMembers(index: WorkIndex, members: ReadonlyArray<ProtoThread>): WorkCounts {
  const own = { working: 0, needsYou: 0, done: 0 };
  for (const t of members) {
    if (!isCurrent(index, t)) continue;
    if (t.state === "working") own.working += 1;
    else if (t.state === "blocked" || t.state === "failed") own.needsYou += 1;
    else if (t.state === "completed") own.done += 1;
  }
  const below = countWork(
    index,
    members.filter((t) => isCurrent(index, t)).map((t) => t.id),
  );
  return {
    working: own.working + below.working,
    needsYou: own.needsYou + below.needsYou,
    done: own.done + below.done,
  };
}

/** Short phrase such as `2 working · 1 needs you`; null when nothing is live. */
export function countsLabel(counts: WorkCounts, options?: { readonly includeDone?: boolean }) {
  const parts: string[] = [];
  if (counts.working > 0) parts.push(`${counts.working} working`);
  if (counts.needsYou > 0)
    parts.push(`${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you`);
  if (options?.includeDone === true && counts.done > 0) parts.push(`${counts.done} done`);
  return parts.length === 0 ? null : parts.join(" · ");
}

export interface TraySection {
  readonly containerId: string;
  readonly title: string;
  readonly effort: ProtoEffort | null;
  readonly members: ReadonlyArray<ProtoThread>;
}

export interface Tray {
  readonly containerId: string;
  /** Bare children when the coordinator has no current efforts. */
  readonly bare: ReadonlyArray<ProtoThread>;
  readonly sections: ReadonlyArray<TraySection>;
  readonly pastContainerId: string;
  readonly pastEfforts: ReadonlyArray<ProtoEffort>;
}

/** The delegated-work tray under a coordinator; null when the thread never delegated. */
export function coordinatorTray(index: WorkIndex, coordinatorId: string): Tray | null {
  const children = index.childrenOf.get(coordinatorId);
  if (children === undefined || children.length === 0) return null;
  const efforts = index.effortsOf.get(coordinatorId) ?? [];
  const currentEfforts = efforts.filter((e) => isEffortCurrent(index, e));
  const pastEfforts = efforts.filter((e) => !isEffortCurrent(index, e));
  const currentChildren = children.filter((t) => isCurrent(index, t));
  const currentEffortIds = new Set(currentEfforts.map((e) => e.id));
  const ungrouped = currentChildren.filter(
    (t) => t.effortId === null || !currentEffortIds.has(t.effortId),
  );
  const sections: TraySection[] = currentEfforts.map((effort) => ({
    containerId: `effort:${effort.id}`,
    title: effort.title,
    effort,
    members: currentChildren.filter((t) => t.effortId === effort.id),
  }));
  if (sections.length > 0 && ungrouped.length > 0) {
    sections.push({
      containerId: `other:${coordinatorId}`,
      title: "Other delegated work",
      effort: null,
      members: ungrouped,
    });
  }
  return {
    containerId: `tray:${coordinatorId}`,
    bare: sections.length === 0 ? ungrouped : [],
    sections,
    pastContainerId: `past:${coordinatorId}`,
    pastEfforts,
  };
}

/** Earlier attempts reachable through a replacement row, newest first. */
export function supersededChain(index: WorkIndex, thread: ProtoThread): ReadonlyArray<ProtoThread> {
  const chain: ProtoThread[] = [];
  let cursor = thread.replacesId === null ? undefined : index.byId.get(thread.replacesId);
  while (cursor !== undefined && chain.length < 32) {
    chain.push(cursor);
    cursor = cursor.replacesId === null ? undefined : index.byId.get(cursor.replacesId);
  }
  return chain;
}

/** The latest attempt in a replacement chain. */
export function latestAttempt(index: WorkIndex, thread: ProtoThread): ProtoThread {
  let cursor = thread;
  for (let i = 0; i < 32; i += 1) {
    const next = index.replacedBy.get(cursor.id);
    if (next === undefined) return cursor;
    cursor = next;
  }
  return cursor;
}

export interface ThreadPlacement {
  /** The coordinator whose tray owns this row, or null at the top level. */
  readonly coordinatorId: string | null;
  /** Collapsible containers between the top level and the row, outermost first. */
  readonly containers: ReadonlyArray<string>;
}

/**
 * Where a thread's canonical row lives. Settled threads live on the Settled
 * shelf regardless of lineage; a superseded attempt lives behind its latest
 * replacement; everything else sits in its coordinator's tray one hop down,
 * or at the top level.
 */
export function placeThread(index: WorkIndex, threadId: string): ThreadPlacement | null {
  const thread = index.byId.get(threadId);
  if (thread === undefined) return null;
  if (thread.settled) return { coordinatorId: null, containers: ["settled"] };
  if (isSuperseded(index, thread)) {
    const latest = latestAttempt(index, thread);
    const base = placeThread(index, latest.id);
    if (base === null) return null;
    return { ...base, containers: [...base.containers, `attempts:${latest.id}`] };
  }
  if (thread.parentId === null) return { coordinatorId: null, containers: [] };
  const tray = coordinatorTray(index, thread.parentId);
  if (tray === null) return { coordinatorId: null, containers: [] };
  const section = tray.sections.find((s) => s.members.some((m) => m.id === threadId));
  return {
    coordinatorId: thread.parentId,
    containers:
      section === undefined ? [tray.containerId] : [tray.containerId, section.containerId],
  };
}

/** Threads that sit at the top level of the inbox: unsettled roots in scenario order. */
export function topLevelThreads(index: WorkIndex): ReadonlyArray<ProtoThread> {
  return [...index.byId.values()].filter((t) => t.parentId === null && !t.settled);
}

export function settledThreads(index: WorkIndex): ReadonlyArray<ProtoThread> {
  return [...index.byId.values()].filter((t) => t.settled);
}
