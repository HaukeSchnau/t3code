// @effect-diagnostics globalTimers:off - Shelf placement timers run in web and native clients, outside an Effect runtime.
import * as DateTime from "effect/DateTime";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";
import { effectiveSnoozed, type ThreadSnoozeShell } from "./threadSettled.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

export type ThreadNeedKind =
  | "approval"
  | "question"
  | "request"
  | "guest"
  | "subagent"
  | "turn_end"
  | "page";

export interface ThreadNeed {
  readonly kind: ThreadNeedKind;
  /** The ask's text; null for requests, whose kind is the whole story. */
  readonly text: string | null;
  /** When the need started; null where the shell does not say, as for a subagent's request. */
  readonly since: string | null;
}

type ThreadNeedsYouInput = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingUserInputAt"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "openAsks"
> & {
  readonly source?: Pick<
    EnvironmentThreadShell["source"],
    "pendingRuntimeRequest" | "pendingGuestMessageAt"
  >;
};

/**
 * What the thread needs from the user, or null: the one rule every list, count, notification and
 * triage view uses. The thread's own request comes first because it blocks the agent, then a
 * subagent's, a guest's, and the oldest ask. Run state does not matter: a working thread whose
 * page asks still needs the user. A failed run is not a need; it keeps its Failed status.
 */
export function threadNeedsYou(thread: ThreadNeedsYouInput): ThreadNeed | null {
  const request = thread.source?.pendingRuntimeRequest ?? null;
  const requestAt = request === null ? null : DateTime.formatIso(request.createdAt);
  if (thread.hasPendingApprovals) return { kind: "approval", text: null, since: requestAt };
  if (thread.hasPendingUserInput) {
    return {
      kind: request?.card === undefined ? "question" : "request",
      text: null,
      since: thread.pendingUserInputAt ?? requestAt,
    };
  }
  if (thread.pendingSubagentRequest != null) return { kind: "subagent", text: null, since: null };
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return { kind: "guest", text: null, since: thread.source?.pendingGuestMessageAt ?? null };
  }
  const oldest = oldestOpenAsk(thread);
  return oldest === null
    ? null
    : { kind: oldest.source.type, text: oldest.text, since: oldest.raisedAt };
}

/** The ask a thread's need reads from when it has no request of its own. */
export function oldestOpenAsk(thread: Pick<ThreadNeedsYouInput, "openAsks">) {
  return (thread.openAsks ?? []).reduce<
    NonNullable<ThreadNeedsYouInput["openAsks"]>[number] | null
  >(
    (current, ask) =>
      current === null || Date.parse(ask.raisedAt) < Date.parse(current.raisedAt) ? ask : current,
    null,
  );
}

const NEED_LABELS: Record<ThreadNeedKind, string> = {
  approval: "Approval",
  question: "Question",
  request: "Request",
  subagent: "Subagent waiting",
  guest: "Guest message",
  turn_end: "Question",
  page: "Page",
};

/** One line for a list row: the ask's text, or what kind of request waits. */
export function threadNeedLabel(need: ThreadNeed): string {
  return need.text ?? NEED_LABELS[need.kind];
}

/**
 * The Needs you order: the thread waiting longest first. Needs the shell has no start time for
 * (a subagent's request, a guest's message from an older server) follow, the least recently
 * updated first.
 */
export function sortThreadsByNeed<
  T extends ThreadNeedsYouInput &
    Pick<EnvironmentThreadShell, "id" | "environmentId" | "updatedAt">,
>(threads: readonly T[]): T[] {
  const since = new Map(
    threads.map((thread) => [
      thread,
      toSortableTimestamp(threadNeedsYou(thread)?.since ?? undefined),
    ]),
  );
  return [...threads].sort((left, right) => {
    const leftSince = since.get(left) ?? null;
    const rightSince = since.get(right) ?? null;
    if (leftSince !== null && rightSince !== null && leftSince !== rightSince) {
      return leftSince - rightSince;
    }
    if ((leftSince === null) !== (rightSince === null)) return leftSince === null ? 1 : -1;
    return (
      (toSortableTimestamp(left.updatedAt) ?? 0) - (toSortableTimestamp(right.updatedAt) ?? 0) ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId)
    );
  });
}

/**
 * The threads in Needs you, the one waiting longest first: they need the user and are not
 * snoozed. Pass listed threads only (not archived, not shown under a parent). Every count of
 * what needs the user (tab title, badges) reads this.
 */
export function threadsNeedingYou<
  T extends ThreadNeedsYouInput &
    ThreadSnoozeShell &
    Pick<EnvironmentThreadShell, "id" | "environmentId" | "updatedAt">,
>(threads: readonly T[], options: { readonly now: string }): T[] {
  return sortThreadsByNeed(
    threads.filter(
      (thread) => threadNeedsYou(thread) !== null && !effectiveSnoozed(thread, options),
    ),
  );
}

/**
 * A thread its own client is launching reads as preparing until its first run lands.
 * The server commits the thread before its run, so the list would otherwise place it twice.
 */
export function asLaunchingThread<T extends EnvironmentThreadShell>(thread: T): T {
  if (thread.latestRun !== null || thread.runtime !== null) return thread;
  return {
    ...thread,
    runtime: {
      status: "preparing",
      activeRunId: null,
      providerInstanceId: thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: thread.updatedAt,
    },
  };
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "createdAt"
  | "unsettledAt"
  | "latestRun"
  | "latestRunStartedByUser"
  | "latestUserAuthoredMessageAt"
  | "returnedAt"
>;

/**
 * The latest run started without the user (a wake, another agent, a schedule) and did not fail.
 * It notifies nobody and leaves the thread where it was in the inbox; an ask it raises still
 * brings the thread to Needs you.
 */
function isQuietRun(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "latestRunStartedByUser">,
): boolean {
  return thread.latestRunStartedByUser === false && thread.latestRun?.status !== "failed";
}

/**
 * When the thread last came back to the inbox, the time the inbox orders by: the user's own
 * message or unsettle, or the server's `returnedAt` (a run they started ended, a run failed, an
 * agent asked). Without `returnedAt` (older servers, history from before it), the latest run
 * stands in unless it was quiet, and so does a return this client saw.
 */
export function inboxReturnTime<T extends InboxThreadInput>(
  thread: T,
  observedReturnAt?: (thread: T) => number | undefined,
): number {
  if (thread.returnedAt !== undefined) {
    return Math.max(
      toSortableTimestamp(thread.createdAt) ?? 0,
      toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
      toSortableTimestamp(thread.latestUserAuthoredMessageAt ?? undefined) ?? 0,
      toSortableTimestamp(thread.returnedAt) ?? 0,
    );
  }
  // A quiet run keeps the place the user's own last message gave the thread.
  const run = isQuietRun(thread) ? null : thread.latestRun;
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
    toSortableTimestamp(
      (run === null ? thread.latestUserAuthoredMessageAt : run.requestedAt) ?? undefined,
    ) ?? 0,
    toSortableTimestamp(run?.completedAt ?? undefined) ?? 0,
    observedReturnAt?.(thread) ?? 0,
  );
}

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [thread, inboxReturnTime(thread, observedReturnAt)]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

type TrackedInboxThread = WorkingThreadInput &
  InboxThreadInput &
  Partial<
    Pick<
      EnvironmentThreadShell,
      | "archivedAt"
      | "deletedAt"
      | "pinnedAt"
      | "settledOverride"
      | "settledAt"
      | "snoozedAt"
      | "snoozedUntil"
      | "activeOrderKey"
      | "pendingGuestMessageCount"
      | "openAsks"
    >
  >;

type ThreadKeyInput = Pick<EnvironmentThreadShell, "environmentId" | "id">;

/**
 * How long a thread that stopped working keeps reading as working. An orchestrator
 * run can end moments before its continuation starts, so clients wait this long
 * before treating the thread as done.
 */
const WORKING_EXIT_GRACE_MS = 2_000;

/**
 * A run that ended this long ago has no continuation about to start, so its thread gets no
 * grace. A client sees this for work that ended while it was closed or disconnected; the
 * margin is wide so a client clock that runs ahead of the server does not cancel the grace.
 */
const STALE_EXIT_MS = 60_000;

/**
 * Keep one at module scope so placement survives routes that unmount the list. Call
 * `observe` when the shells or the snapshot version change, or with null while the beta
 * is off. Its result stays fixed, so a list built from it can be cached.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: ThreadKeyInput) => `${thread.environmentId}:${thread.id}`;
  const states = new Map<
    string,
    { working: boolean; deadline: number | null; placement: string | null; quiet: boolean }
  >();
  const returns = new Map<string, number>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  const now = () => {
    // @effect-diagnostics-next-line globalDate:off - The grace deadline is wall-clock time shared by web and native clients.
    return Date.now();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    let next = Infinity;
    for (const state of states.values()) {
      if (state.deadline !== null) next = Math.min(next, state.deadline);
    }
    if (next === Infinity) return;
    timer = setTimeout(
      () => {
        const at = now();
        for (const [key, state] of states) {
          if (state.deadline !== null && state.deadline <= at) {
            state.working = false;
            state.deadline = null;
            if (!state.quiet) returns.set(key, at);
          }
        }
        schedule();
        version++;
        for (const listener of listeners) listener();
      },
      Math.max(0, next - now()),
    );
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
    observe(threads: readonly TrackedInboxThread[] | null): {
      readonly isWorking: (thread: WorkingThreadInput & ThreadKeyInput) => boolean;
      readonly returnedAt: (thread: ThreadKeyInput) => number | undefined;
    } {
      if (threads === null) {
        clearTimeout(timer);
        timer = undefined;
        states.clear();
        returns.clear();
        return { isWorking: isThreadWorking, returnedAt: () => undefined };
      }
      const present = new Set<string>();
      const at = now();
      // @effect-diagnostics-next-line globalDate:off - Snooze checks compare wall-clock ISO times.
      const observedAt = new Date(at).toISOString();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        const previous = states.get(key);
        const actual = isThreadWorking(thread);
        const placement =
          actual || previous?.working
            ? JSON.stringify([
                thread.archivedAt,
                thread.deletedAt,
                thread.pinnedAt,
                thread.settledOverride,
                thread.settledAt,
                thread.snoozedAt,
                thread.snoozedUntil,
                thread.activeOrderKey,
              ])
            : null;
        const actionable =
          thread.hasPendingApprovals ||
          thread.hasPendingUserInput ||
          thread.pendingSubagentRequest != null ||
          (thread.pendingGuestMessageCount ?? 0) > 0 ||
          (thread.openAsks?.length ?? 0) > 0 ||
          (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) ||
          thread.runtime?.lastError != null ||
          thread.latestRun?.status === "failed";
        const moved = previous !== undefined && previous.placement !== placement;
        const excluded =
          thread.archivedAt != null ||
          thread.deletedAt != null ||
          thread.pinnedAt != null ||
          thread.settledOverride === "settled" ||
          effectiveSnoozed(thread, { now: observedAt });
        // Only shelf placement is held: execution state and attention requests stay authoritative.
        const endedAt = toSortableTimestamp(thread.latestRun?.completedAt ?? undefined);
        const endedLongAgo = endedAt !== null && endedAt <= at - STALE_EXIT_MS;
        const deadline =
          !actual && previous?.working && !actionable && !moved && !excluded && !endedLongAgo
            ? (previous.deadline ?? at + WORKING_EXIT_GRACE_MS)
            : null;
        const working = actual || (deadline !== null && deadline > at);
        const quiet = isQuietRun(thread);
        if (previous?.working && !working && !quiet) returns.set(key, at);
        states.set(key, { working, deadline: working ? deadline : null, placement, quiet });
      }
      for (const key of states.keys()) {
        if (!present.has(key)) {
          states.delete(key);
          returns.delete(key);
        }
      }
      schedule();
      const observedWorking = new Map<string, boolean>();
      states.forEach((state, key) => observedWorking.set(key, state.working));
      const observedReturns = new Map(returns);
      return {
        isWorking: (thread) => observedWorking.get(keyOf(thread)) ?? isThreadWorking(thread),
        returnedAt: (thread) => observedReturns.get(keyOf(thread)),
      };
    },
    isWorking: (thread: WorkingThreadInput & ThreadKeyInput) =>
      states.get(keyOf(thread))?.working ?? isThreadWorking(thread),
    returnedAt: (thread: ThreadKeyInput) => returns.get(keyOf(thread)),
  };
}
