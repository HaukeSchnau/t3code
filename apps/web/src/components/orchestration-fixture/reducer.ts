/**
 * Pure reducer over fixture events plus the selectors the UI reads.
 *
 * Wake-on-settle lives here on purpose: a child reaching a terminal or
 * blocked state notifies its parent, and an open wait coalesces those
 * notifications into one. That is the durable behavior the production
 * server would own, so the prototype derives it instead of scripting it.
 */
import {
  BLOCKED_STATUSES,
  EMPTY_FIXTURE_STATE,
  TERMINAL_STATUSES,
  type FixtureEffort,
  type FixtureEvent,
  type FixtureState,
  type FixtureThread,
  type FixtureThreadStatus,
  type FixtureTimelineItem,
  type FixtureWait,
} from "./model";

let itemSequence = 0;
function itemId(prefix: string): string {
  itemSequence += 1;
  return `${prefix}:${itemSequence}`;
}

function withThread(
  state: FixtureState,
  threadId: string,
  update: (thread: FixtureThread) => FixtureThread,
): FixtureState {
  const thread = state.threads[threadId];
  if (thread === undefined) return state;
  return { ...state, threads: { ...state.threads, [threadId]: update(thread) } };
}

function appendItem(thread: FixtureThread, item: FixtureTimelineItem): FixtureThread {
  return { ...thread, timeline: [...thread.timeline, item], updatedAt: item.at };
}

function withEffort(
  state: FixtureState,
  effortId: string,
  update: (effort: FixtureEffort) => FixtureEffort,
): FixtureState {
  const effort = state.efforts[effortId];
  if (effort === undefined) return state;
  return { ...state, efforts: { ...state.efforts, [effortId]: update(effort) } };
}

function withWait(
  state: FixtureState,
  waitId: string,
  update: (wait: FixtureWait) => FixtureWait,
): FixtureState {
  const wait = state.waits[waitId];
  if (wait === undefined) return state;
  return { ...state, waits: { ...state.waits, [waitId]: update(wait) } };
}

function threadTitle(state: FixtureState, threadId: string): string {
  return state.delegations[threadId]?.label ?? state.threads[threadId]?.title ?? threadId;
}

function isTerminal(status: FixtureThreadStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * A thread counts as settled for a wait only when its own status is terminal
 * and it holds no open wait of its own. A parent that idles while waiting on
 * grandchildren is not done, even though its turn ended.
 */
function isSettled(state: FixtureState, threadId: string): boolean {
  const thread = state.threads[threadId];
  if (thread === undefined || !isTerminal(thread.status)) return false;
  return !Object.values(state.waits).some(
    (wait) => wait.status === "open" && wait.threadId === threadId,
  );
}

function waitSatisfied(state: FixtureState, wait: FixtureWait): boolean {
  const settled = wait.targets.map((id) => isSettled(state, id));
  return wait.condition === "all" ? settled.every(Boolean) : settled.some(Boolean);
}

/** Open waits on `parentId` that cover `childId`. */
function coveringWaits(state: FixtureState, parentId: string, childId: string): FixtureWait[] {
  return Object.values(state.waits).filter(
    (wait) =>
      wait.status === "open" && wait.threadId === parentId && wait.targets.includes(childId),
  );
}

function outcomeText(status: FixtureThreadStatus): string {
  switch (status) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "stopped":
      return "was stopped";
    case "blocked-approval":
      return "needs approval";
    case "blocked-input":
      return "needs input";
    default:
      return "changed";
  }
}

/**
 * Re-evaluates waits and delivers wakes after `childId` changed status.
 * Blocked and failed children always wake the parent with attention.
 * Completed children wake through their wait, or directly when no wait
 * covers them.
 */
function settleWakes(state: FixtureState, childId: string, at: string): FixtureState {
  const child = state.threads[childId];
  const delegation = state.delegations[childId];
  if (child === undefined || delegation === undefined) return state;
  const parentId = delegation.parentId;
  const label = threadTitle(state, childId);
  let next = state;

  if (BLOCKED_STATUSES.has(child.status) || child.status === "failed") {
    next = withThread(next, parentId, (parent) =>
      appendItem(parent, {
        kind: "wake",
        id: itemId("wake"),
        text: `${label} ${outcomeText(child.status)}`,
        sourceIds: [childId],
        tone: "attention",
        at,
      }),
    );
    if (!isTerminal(child.status)) return next;
  }

  if (!isTerminal(child.status)) return next;

  const waits = coveringWaits(next, parentId, childId);
  if (waits.length === 0) {
    if (child.status === "completed") {
      next = withThread(next, parentId, (parent) =>
        appendItem(parent, {
          kind: "wake",
          id: itemId("wake"),
          text: `${label} finished`,
          sourceIds: [childId],
          tone: "info",
          at,
        }),
      );
    }
    return next;
  }

  for (const wait of waits) {
    if (!waitSatisfied(next, wait)) continue;
    next = withWait(next, wait.id, (current) => ({
      ...current,
      status: "satisfied",
      resolvedAt: at,
    }));
    const finished = wait.targets.filter((id) => isTerminal(next.threads[id]?.status ?? "queued"));
    const names = finished.map((id) => threadTitle(next, id));
    next = withThread(next, parentId, (parent) =>
      appendItem(parent, {
        kind: "wake",
        id: itemId("wake"),
        text:
          names.length === 1
            ? `${names[0]} finished · wait satisfied`
            : `${names.join(", ")} finished · wait satisfied`,
        sourceIds: finished,
        tone: "info",
        at,
      }),
    );
  }
  return next;
}

export function applyFixtureEvent(state: FixtureState, event: FixtureEvent): FixtureState {
  const base: FixtureState = { ...state, now: event.at };
  switch (event.type) {
    case "project.added":
      return { ...base, projects: [...base.projects, event.project] };

    case "thread.created": {
      const status = event.status ?? "running";
      const effortId = event.delegation?.effortId ?? null;
      const thread: FixtureThread = {
        ...event.thread,
        createdAt: event.at,
        updatedAt: event.at,
        status,
        activity: status === "running" ? "Reading the brief" : null,
        timeline: [
          {
            kind: "message",
            id: itemId("msg"),
            role: "user",
            text: event.prompt,
            at: event.at,
            ...(event.delegation ? { fromId: event.delegation.parentId } : {}),
          },
        ],
        artifacts: {},
        pinnedAt: null,
        latestUserMessageAt: event.at,
        startedAt: status === "queued" ? null : event.at,
        settledAt: isTerminal(status) ? event.at : null,
        effortId,
      };
      let next: FixtureState = {
        ...base,
        threads: { ...base.threads, [thread.id]: thread },
        threadOrder: [...base.threadOrder, thread.id],
      };
      if (event.replaces !== undefined) {
        next = { ...next, replacements: { ...next.replacements, [event.replaces]: thread.id } };
        // A replacement inherits the waits that covered the thread it supersedes.
        for (const wait of Object.values(next.waits)) {
          if (wait.status !== "open" || !wait.targets.includes(event.replaces)) continue;
          next = withWait(next, wait.id, (current) => ({
            ...current,
            targets: current.targets.map((id) => (id === event.replaces ? thread.id : id)),
          }));
        }
      }
      const delegation = event.delegation;
      if (delegation === undefined) return next;
      next = {
        ...next,
        delegations: {
          ...next.delegations,
          [thread.id]: {
            childId: thread.id,
            parentId: delegation.parentId,
            label: delegation.label,
            turnId: delegation.turnId,
            at: event.at,
          },
        },
      };
      if (effortId !== null) {
        const effort = next.efforts[effortId];
        const priorMembers = effort?.members.length ?? 0;
        next = withEffort(next, effortId, (current) => ({
          ...current,
          members: [...current.members, thread.id],
        }));
        if (event.replaces !== undefined) {
          next = withThread(next, delegation.parentId, (parent) =>
            appendItem(parent, {
              kind: "note",
              id: itemId("note"),
              text: `Replaced ${threadTitle(next, event.replaces ?? "")} with ${delegation.label}`,
              at: event.at,
            }),
          );
        } else if (
          effort !== undefined &&
          priorMembers > 0 &&
          effort.coordinatorId === delegation.parentId
        ) {
          // Later launches into an existing effort are one-line rows; the
          // effort card at the opening launch already shows every member.
          const lastItem = next.threads[delegation.parentId]?.timeline.at(-1);
          const sameTurnNote =
            lastItem?.kind === "note" &&
            lastItem.at === event.at &&
            lastItem.text.startsWith("Added ");
          if (sameTurnNote) {
            next = withThread(next, delegation.parentId, (parent) => ({
              ...parent,
              timeline: parent.timeline.map((item) =>
                item.id === lastItem.id && item.kind === "note"
                  ? {
                      ...item,
                      text: item.text.replace(
                        ` to ${effort.title}`,
                        `, ${delegation.label} to ${effort.title}`,
                      ),
                    }
                  : item,
              ),
            }));
          } else {
            next = withThread(next, delegation.parentId, (parent) =>
              appendItem(parent, {
                kind: "note",
                id: itemId("note"),
                text: `Added ${delegation.label} to ${effort.title}`,
                at: event.at,
              }),
            );
          }
        }
        return next;
      }
      // No effort: group by launching turn, one card per turn.
      return withThread(next, delegation.parentId, (parent) => {
        const existing = parent.timeline.find(
          (item): item is Extract<FixtureTimelineItem, { kind: "launch" }> =>
            item.kind === "launch" && item.turnId === delegation.turnId,
        );
        if (existing) {
          return {
            ...parent,
            timeline: parent.timeline.map((item) =>
              item.id === existing.id && item.kind === "launch"
                ? { ...item, childIds: [...item.childIds, thread.id] }
                : item,
            ),
          };
        }
        return appendItem(parent, {
          kind: "launch",
          id: itemId("launch"),
          turnId: delegation.turnId,
          childIds: [thread.id],
          at: event.at,
        });
      });
    }

    case "thread.status": {
      const current = base.threads[event.threadId];
      if (current === undefined || current.status === event.status) {
        return event.activity === undefined
          ? base
          : withThread(base, event.threadId, (thread) => ({
              ...thread,
              activity: event.activity ?? null,
              updatedAt: event.at,
            }));
      }
      const next = withThread(base, event.threadId, (thread) => ({
        ...thread,
        status: event.status,
        activity: event.activity === undefined ? thread.activity : event.activity,
        updatedAt: event.at,
        startedAt: thread.startedAt ?? (event.status === "queued" ? null : event.at),
        settledAt: isTerminal(event.status) ? event.at : null,
      }));
      return settleWakes(next, event.threadId, event.at);
    }

    case "thread.message": {
      let next = withThread(base, event.threadId, (thread) =>
        appendItem(
          {
            ...thread,
            latestUserMessageAt: event.role === "user" ? event.at : thread.latestUserMessageAt,
          },
          {
            kind: "message",
            id: itemId("msg"),
            role: event.role,
            text: event.text,
            at: event.at,
            ...(event.fromId !== undefined ? { fromId: event.fromId } : {}),
          },
        ),
      );
      if (event.fromId !== undefined) {
        next = {
          ...next,
          handoffs: [
            ...next.handoffs,
            {
              id: itemId("handoff"),
              fromId: event.fromId,
              toId: event.threadId,
              text: event.text,
              at: event.at,
            },
          ],
        };
      }
      return next;
    }

    case "thread.artifacts":
      return withThread(base, event.threadId, (thread) => ({
        ...thread,
        artifacts: { ...thread.artifacts, ...event.artifacts },
        updatedAt: event.at,
      }));

    case "thread.pinned":
      return withThread(base, event.threadId, (thread) => ({ ...thread, pinnedAt: event.at }));

    case "thread.stopped": {
      const current = base.threads[event.threadId];
      if (current === undefined || isTerminal(current.status)) return base;
      const next = withThread(base, event.threadId, (thread) => ({
        ...thread,
        status: "stopped",
        activity: "Stopped by user",
        settledAt: event.at,
        updatedAt: event.at,
      }));
      return settleWakes(next, event.threadId, event.at);
    }

    case "approval.requested": {
      const next = withThread(base, event.threadId, (thread) =>
        appendItem(
          { ...thread, status: "blocked-approval", activity: "Waiting for approval" },
          {
            kind: "approval",
            id: itemId("approval"),
            text: event.text,
            resolution: "pending",
            at: event.at,
          },
        ),
      );
      return settleWakes(next, event.threadId, event.at);
    }

    case "approval.resolved": {
      const current = base.threads[event.threadId];
      if (current === undefined || current.status !== "blocked-approval") return base;
      return withThread(base, event.threadId, (thread) => ({
        ...thread,
        status: event.approved ? "running" : "stopped",
        activity: event.approved ? "Applying the approved change" : "Denied by user",
        settledAt: event.approved ? null : event.at,
        updatedAt: event.at,
        timeline: thread.timeline.map((item) =>
          item.kind === "approval" && item.resolution === "pending"
            ? { ...item, resolution: event.approved ? "approved" : "denied" }
            : item,
        ),
      }));
    }

    case "effort.opened": {
      const effort: FixtureEffort = {
        id: event.effortId,
        coordinatorId: event.coordinatorId,
        title: event.title,
        openedAt: event.at,
        closedAt: null,
        members: [],
      };
      const next: FixtureState = {
        ...base,
        efforts: { ...base.efforts, [effort.id]: effort },
        effortOrder: [...base.effortOrder, effort.id],
      };
      return withThread(next, event.coordinatorId, (thread) =>
        appendItem(thread, {
          kind: "effort",
          id: itemId("effort"),
          effortId: effort.id,
          at: event.at,
        }),
      );
    }

    case "effort.closed": {
      const effort = base.efforts[event.effortId];
      if (effort === undefined || effort.closedAt !== null) return base;
      let next = withEffort(base, event.effortId, (current) => ({
        ...current,
        closedAt: event.at,
      }));
      let stopped = 0;
      if (event.stopMembers) {
        for (const memberId of effort.members) {
          const member = next.threads[memberId];
          if (member === undefined || isTerminal(member.status)) continue;
          stopped += 1;
          next = withThread(next, memberId, (thread) => ({
            ...thread,
            status: "stopped",
            activity: "Stopped when the effort closed",
            settledAt: event.at,
            updatedAt: event.at,
          }));
        }
      }
      // Closing an effort cancels waits that only cover its members.
      for (const wait of Object.values(next.waits)) {
        if (wait.status !== "open" || wait.threadId !== effort.coordinatorId) continue;
        if (!wait.targets.every((id) => effort.members.includes(id))) continue;
        next = withWait(next, wait.id, (current) => ({
          ...current,
          status: "cancelled",
          resolvedAt: event.at,
        }));
      }
      return withThread(next, effort.coordinatorId, (thread) =>
        appendItem(thread, {
          kind: "note",
          id: itemId("note"),
          text:
            stopped > 0
              ? `Closed ${effort.title} · stopped ${stopped} worker${stopped === 1 ? "" : "s"}`
              : `Closed ${effort.title}`,
          at: event.at,
        }),
      );
    }

    case "effort.reopened": {
      const effort = base.efforts[event.effortId];
      if (effort === undefined || effort.closedAt === null) return base;
      const next = withEffort(base, event.effortId, (current) => ({ ...current, closedAt: null }));
      return withThread(next, effort.coordinatorId, (thread) =>
        appendItem(thread, {
          kind: "note",
          id: itemId("note"),
          text: `Reopened ${effort.title}`,
          at: event.at,
        }),
      );
    }

    case "effort.member.moved": {
      const thread = base.threads[event.threadId];
      if (thread === undefined || thread.effortId === event.effortId) return base;
      const fromEffort = thread.effortId === null ? undefined : base.efforts[thread.effortId];
      const toEffort = event.effortId === null ? undefined : base.efforts[event.effortId];
      let next = base;
      if (fromEffort !== undefined) {
        next = withEffort(next, fromEffort.id, (current) => ({
          ...current,
          members: current.members.filter((id) => id !== event.threadId),
        }));
      }
      if (toEffort !== undefined) {
        next = withEffort(next, toEffort.id, (current) => ({
          ...current,
          members: [...current.members, event.threadId],
        }));
      }
      next = withThread(next, event.threadId, (current) => ({
        ...current,
        effortId: event.effortId,
        updatedAt: event.at,
      }));
      const coordinatorId = toEffort?.coordinatorId ?? fromEffort?.coordinatorId;
      if (coordinatorId === undefined) return next;
      const label = threadTitle(next, event.threadId);
      const text =
        toEffort !== undefined && fromEffort !== undefined
          ? `Moved ${label} from ${fromEffort.title} to ${toEffort.title}`
          : toEffort !== undefined
            ? `Moved ${label} into ${toEffort.title}`
            : `Removed ${label} from ${fromEffort?.title ?? "its effort"}`;
      return withThread(next, coordinatorId, (current) =>
        appendItem(current, { kind: "note", id: itemId("note"), text, at: event.at }),
      );
    }

    case "wait.opened": {
      const wait: FixtureWait = {
        id: event.waitId,
        threadId: event.threadId,
        targets: event.targets,
        condition: event.condition,
        openedAt: event.at,
        status: "open",
        resolvedAt: null,
      };
      let next: FixtureState = { ...base, waits: { ...base.waits, [wait.id]: wait } };
      next = withThread(next, event.threadId, (thread) =>
        appendItem(thread, { kind: "wait", id: itemId("wait"), waitId: wait.id, at: event.at }),
      );
      // A wait whose targets already settled resolves immediately.
      if (waitSatisfied(next, wait)) {
        next = withWait(next, wait.id, (current) => ({
          ...current,
          status: "satisfied",
          resolvedAt: event.at,
        }));
      }
      return next;
    }

    case "wait.changed": {
      const wait = base.waits[event.waitId];
      if (wait === undefined || wait.status !== "open" || wait.condition === event.condition) {
        return base;
      }
      let next = withWait(base, event.waitId, (current) => ({
        ...current,
        condition: event.condition,
      }));
      next = withThread(next, wait.threadId, (thread) =>
        appendItem(thread, {
          kind: "note",
          id: itemId("note"),
          text: `Changed wait to ${event.condition === "any" ? "any of" : "all of"} ${wait.targets
            .map((id) => threadTitle(next, id))
            .join(", ")}`,
          at: event.at,
        }),
      );
      const updated = next.waits[event.waitId];
      if (updated !== undefined && waitSatisfied(next, updated)) {
        next = withWait(next, event.waitId, (current) => ({
          ...current,
          status: "satisfied",
          resolvedAt: event.at,
        }));
        const finished = updated.targets.filter((id) =>
          isTerminal(next.threads[id]?.status ?? "queued"),
        );
        next = withThread(next, wait.threadId, (thread) =>
          appendItem(thread, {
            kind: "wake",
            id: itemId("wake"),
            text: `${finished.map((id) => threadTitle(next, id)).join(", ")} finished · wait satisfied`,
            sourceIds: finished,
            tone: "info",
            at: event.at,
          }),
        );
      }
      return next;
    }

    case "wait.cancelled": {
      const wait = base.waits[event.waitId];
      if (wait === undefined || wait.status !== "open") return base;
      const next = withWait(base, event.waitId, (current) => ({
        ...current,
        status: "cancelled",
        resolvedAt: event.at,
      }));
      return withThread(next, wait.threadId, (thread) =>
        appendItem(thread, {
          kind: "note",
          id: itemId("note"),
          text: `Cancelled wait on ${wait.targets.map((id) => threadTitle(next, id)).join(", ")}`,
          at: event.at,
        }),
      );
    }

    case "note":
      return withThread(base, event.threadId, (thread) =>
        appendItem(thread, { kind: "note", id: itemId("note"), text: event.text, at: event.at }),
      );
  }
}

export function reduceFixtureEvents(
  events: ReadonlyArray<FixtureEvent>,
  initial: FixtureState = EMPTY_FIXTURE_STATE,
): FixtureState {
  // Item ids are deterministic per reduction so React keys stay stable when
  // the same log is replayed from the start.
  itemSequence = 0;
  return events.reduce(applyFixtureEvent, initial);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export interface EffortCounts {
  readonly running: number;
  readonly blocked: number;
  readonly completed: number;
  readonly failed: number;
  readonly stopped: number;
  readonly total: number;
}

export function countMembers(state: FixtureState, memberIds: ReadonlyArray<string>): EffortCounts {
  const counts = { running: 0, blocked: 0, completed: 0, failed: 0, stopped: 0, total: 0 };
  for (const id of memberIds) {
    const thread = state.threads[id];
    if (thread === undefined) continue;
    // A replaced thread no longer counts against the effort; its successor does.
    if (state.replacements[id] !== undefined) continue;
    counts.total += 1;
    switch (thread.status) {
      case "queued":
      case "running":
        counts.running += 1;
        break;
      case "blocked-approval":
      case "blocked-input":
        counts.blocked += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "stopped":
        counts.stopped += 1;
        break;
    }
  }
  return counts;
}

/** Short roll-up phrase such as `2 working · 1 needs you · 3 done`. */
export function countsLabel(counts: EffortCounts): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} working`);
  if (counts.blocked > 0)
    parts.push(`${counts.blocked} need${counts.blocked === 1 ? "s" : ""} you`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.completed > 0) parts.push(`${counts.completed} done`);
  if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
  return parts.length === 0 ? "no workers yet" : parts.join(" · ");
}

export function childrenOf(state: FixtureState, parentId: string): ReadonlyArray<string> {
  return state.threadOrder.filter((id) => state.delegations[id]?.parentId === parentId);
}

export function effortsOf(
  state: FixtureState,
  coordinatorId: string,
): ReadonlyArray<FixtureEffort> {
  return state.effortOrder
    .map((id) => state.efforts[id])
    .filter((effort): effort is FixtureEffort => effort?.coordinatorId === coordinatorId);
}

export function openWaitsOf(state: FixtureState, threadId: string): ReadonlyArray<FixtureWait> {
  return Object.values(state.waits).filter(
    (wait) => wait.status === "open" && wait.threadId === threadId,
  );
}

export function depthOf(state: FixtureState, threadId: string): number {
  let depth = 0;
  let current = state.delegations[threadId];
  while (current !== undefined && depth < 8) {
    depth += 1;
    current = state.delegations[current.parentId];
  }
  return depth;
}

/** True when the thread waits on children, so it reads as Monitoring, not Working. */
export function isWaiting(state: FixtureState, threadId: string): boolean {
  return openWaitsOf(state, threadId).length > 0;
}

export type LensKind = "answer" | "diff" | "files" | "preview" | "terminal";

export const LENS_ORDER: ReadonlyArray<LensKind> = [
  "answer",
  "diff",
  "files",
  "preview",
  "terminal",
];

/** Lenses offered for a selection: a lens shows when at least one thread has it. */
export function availableLenses(
  state: FixtureState,
  threadIds: ReadonlyArray<string>,
): ReadonlyArray<LensKind> {
  const threads = threadIds
    .map((id) => state.threads[id])
    .filter((thread): thread is FixtureThread => thread !== undefined);
  return LENS_ORDER.filter((lens) => {
    switch (lens) {
      case "answer":
        return true;
      case "diff":
        return threads.some((thread) => thread.artifacts.patch !== undefined);
      case "files":
        return threads.some((thread) => thread.artifacts.files !== undefined);
      case "preview":
        return threads.some((thread) => thread.artifacts.preview !== undefined);
      case "terminal":
        return threads.some((thread) => thread.artifacts.terminal !== undefined);
    }
  });
}

/** Diff when every selected thread has changes, otherwise Answer. */
export function defaultLens(state: FixtureState, threadIds: ReadonlyArray<string>): LensKind {
  const allHaveDiff =
    threadIds.length > 0 &&
    threadIds.every((id) => state.threads[id]?.artifacts.patch !== undefined);
  return allHaveDiff ? "diff" : "answer";
}

/** The thread's final assistant message, which is its report. */
export function latestAnswer(thread: FixtureThread): string | null {
  for (let index = thread.timeline.length - 1; index >= 0; index -= 1) {
    const item = thread.timeline[index];
    if (item?.kind === "message" && item.role === "assistant") return item.text;
  }
  return thread.artifacts.answer ?? null;
}

export function needsAttention(thread: FixtureThread): boolean {
  return BLOCKED_STATUSES.has(thread.status) || thread.status === "failed";
}
