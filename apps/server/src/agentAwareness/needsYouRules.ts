import {
  isDelegatedAppThread,
  isListedThreadLineage,
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type RuntimeRequestId,
  type ThreadId,
  type ThreadOpenAsk,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  monitorHoldsWakeCompletion,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import type { NewSubject } from "./NeedsYouLedger.ts";

/** Something older than this no longer alerts; it bounds what a restart or reconnect catches up. */
export const NEEDS_YOU_ALERT_WINDOW_MS = 10 * 60_000;
const REMINDER_AFTER_MS = 60 * 60_000;
/** A reminder due longer ago than this, such as after a long outage, no longer goes out. */
const REMINDER_LATEST_MS = 24 * 60 * 60_000;
/** A digest due longer ago than this, after the server was down through the evening, is skipped. */
export const DIGEST_LATE_MS = 30 * 60_000;
const DIGEST_HOUR = 19;
const MAX_ANCESTOR_HOPS = 16;

type Shell = OrchestrationV2ThreadShell;

const millis = (value: string | DateTime.Utc | null | undefined): number | null => {
  if (value == null) return null;
  if (typeof value !== "string") return DateTime.toEpochMillis(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const isOpen = (shell: Pick<Shell, "archivedAt" | "deletedAt">) =>
  shell.archivedAt === null && shell.deletedAt == null;

/** Threads the user's lists show: not subagents, side chats or tasks delegated from elsewhere. */
export const isTopLevel = (shell: Pick<Shell, "lineage" | "delegatedFrom">) =>
  isListedThreadLineage(shell.lineage) && !isDelegatedAppThread(shell);

/** A request the thread waits on: its own, or one of its child threads' attributed to it. */
export interface NeedsYouRequest {
  readonly id: RuntimeRequestId;
  readonly kind: "approval" | "input";
  readonly createdAt: number;
}

/** The thread's own request that waits on the user, if any. */
function ownNeedsYouRequest(shell: Pick<Shell, "pendingRuntimeRequest">): NeedsYouRequest | null {
  const request = shell.pendingRuntimeRequest;
  if (request === null || request.kind === "auth_refresh") return null;
  return {
    id: request.id,
    kind: request.kind === "user_input" ? "input" : "approval",
    createdAt: DateTime.toEpochMillis(request.createdAt),
  };
}

/**
 * Whether a child thread's request of this kind waits on the user through its parent, like the
 * clients' subagent roll-up (`subagentAwaitsApproval`): a subagent's approval (its coordinator
 * answers its questions), or a side chat's question or approval.
 */
const childRequestReachesParent = (
  child: Pick<Shell, "lineage" | "activityRunStatus" | "creationSource">,
  kind: NeedsYouRequest["kind"],
) =>
  child.lineage.sideChat === true ||
  (kind === "approval" &&
    child.lineage.relationshipToParent === "subagent" &&
    !isProviderNativeSubagentThread(child) &&
    // The activity run stays set when a follow-up is queued behind a blocked run.
    child.activityRunStatus != null);

/** The listed ancestor of a child thread, by walking its parents. */
function listedAncestor<T extends Pick<Shell, "id" | "lineage">>(
  child: T,
  shellOf: (threadId: ThreadId) => T | undefined,
): T | null {
  let parentId = child.lineage.parentThreadId;
  for (let hop = 0; parentId !== null && hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const parent = shellOf(parentId);
    if (parent === undefined) return null;
    if (isListedThreadLineage(parent.lineage)) return parent;
    parentId = parent.lineage.parentThreadId;
  }
  return null;
}

/** The listed thread a request of this kind in `thread` waits on the user through, if any. */
export function requestOwner<T extends Pick<Shell, "id" | "lineage">>(
  thread: T & Pick<Shell, "archivedAt" | "deletedAt" | "activityRunStatus" | "creationSource">,
  kind: NeedsYouRequest["kind"],
  shellOf: (threadId: ThreadId) => T | undefined,
): T | null {
  if (!isOpen(thread)) return null;
  if (isListedThreadLineage(thread.lineage)) return thread;
  return childRequestReachesParent(thread, kind) ? listedAncestor(thread, shellOf) : null;
}

/** The requests child threads wait on, by the listed ancestor that answers for them. */
export function childNeedsYouRequests(
  shells: Iterable<Shell>,
): ReadonlyMap<ThreadId, ReadonlyArray<NeedsYouRequest>> {
  const byId = new Map<ThreadId, Shell>();
  for (const shell of shells) byId.set(shell.id, shell);
  const requests = new Map<ThreadId, Array<NeedsYouRequest>>();
  for (const child of byId.values()) {
    if (isListedThreadLineage(child.lineage)) continue;
    const request = ownNeedsYouRequest(child);
    if (request === null) continue;
    const parent = requestOwner(child, request.kind, (threadId) => byId.get(threadId));
    if (parent === null) continue;
    const listed = requests.get(parent.id);
    if (listed === undefined) requests.set(parent.id, [request]);
    else listed.push(request);
  }
  return requests;
}

export interface NeedsYouNeed {
  readonly kind: "approval" | "input";
  readonly text: string;
  readonly since: number | null;
}

/**
 * What a listed thread needs from the user by the clients' `threadNeedsYou` rule: its own
 * request, then a child thread's, a guest's message, and the oldest ask.
 */
export function shellNeed(
  shell: Shell,
  childRequests: ReadonlyArray<NeedsYouRequest> = [],
): NeedsYouNeed | null {
  if (!isOpen(shell) || !isTopLevel(shell)) return null;
  const request =
    ownNeedsYouRequest(shell) ??
    childRequests.reduce<NeedsYouRequest | null>(
      (oldest, child) => (oldest === null || child.createdAt < oldest.createdAt ? child : oldest),
      null,
    );
  if (request !== null) {
    const card = shell.pendingRuntimeRequest?.card !== undefined;
    return {
      kind: request.kind,
      text: card ? "Request" : request.kind === "input" ? "Question" : "Approval needed",
      since: request.createdAt,
    };
  }
  if ((shell.pendingGuestMessageCount ?? 0) > 0) {
    return { kind: "input", text: "Guest message", since: millis(shell.pendingGuestMessageAt) };
  }
  const oldest = (shell.openAsks ?? []).reduce<ThreadOpenAsk | null>(
    (current, ask) =>
      current === null || Date.parse(ask.raisedAt) < Date.parse(current.raisedAt) ? ask : current,
    null,
  );
  return oldest === null
    ? null
    : { kind: "input", text: oldest.text, since: Date.parse(oldest.raisedAt) };
}

export interface NeedsYouThread {
  readonly shell: Shell;
  /** Requests of its subagents and side chats, which it answers for. */
  readonly childRequests: ReadonlyArray<NeedsYouRequest>;
  readonly need: NeedsYouNeed | null;
  readonly snoozed: boolean;
}

/**
 * Every listed thread with what it needs, child requests attributed to their listed ancestor,
 * by the server's snooze rule. A child's request wakes a snoozed parent, as on the clients. The
 * phone's count and the watch's list read this.
 */
export function needsYouThreads(
  shells: Iterable<Shell>,
  nowMs: number,
): ReadonlyArray<NeedsYouThread> {
  const all = [...shells];
  const children = childNeedsYouRequests(all);
  return all.flatMap((shell) => {
    if (!isOpen(shell) || !isTopLevel(shell)) return [];
    const childRequests = children.get(shell.id) ?? [];
    return [
      {
        shell,
        childRequests,
        need: shellNeed(shell, childRequests),
        snoozed: childRequests.length === 0 && isSnoozed(shell, nowMs),
      },
    ];
  });
}

/**
 * When a need reminds: an hour after it started, or, when a snooze covered it, an hour after the
 * snooze ended, also when the user woke the thread early (`lastSnoozeWakeAt`).
 */
export function reminderDueAt(
  since: number,
  shell: Pick<Shell, "snoozedAt" | "snoozedUntil" | "lastSnoozeWakeAt">,
): number {
  const snoozedAt = millis(shell.snoozedAt);
  const snoozedUntil = millis(shell.snoozedUntil);
  const lastWake = millis(shell.lastSnoozeWakeAt);
  let start = since;
  if (snoozedAt !== null && snoozedUntil !== null && since <= snoozedAt) {
    start = Math.max(start, snoozedUntil);
  }
  if (lastWake !== null && since <= lastWake) start = Math.max(start, lastWake);
  return start + REMINDER_AFTER_MS;
}

/** Today's evening digest once 19:00 local time has passed, keyed by the local date. */
export function dueNeedsYouDigest(
  nowMs: number,
): { readonly id: string; readonly dueAt: number } | null {
  // @effect-diagnostics-next-line globalDate:off - The digest follows the local wall clock.
  const due = new Date(nowMs);
  due.setHours(DIGEST_HOUR, 0, 0, 0);
  if (due.getTime() > nowMs) return null;
  const date = [
    due.getFullYear(),
    String(due.getMonth() + 1).padStart(2, "0"),
    String(due.getDate()).padStart(2, "0"),
  ].join("-");
  return { id: `digest:${date}`, dueAt: due.getTime() };
}

/** What current state says about a subject. */
export interface SubjectState {
  /** The current shell of the thread it is about. */
  readonly shell: Shell | null;
  /** The need (or a reminder's need) is still open where it lives; true for runs. */
  readonly needOpen: boolean;
  /** A completion whose run has an ask, which takes its place. */
  readonly superseded: boolean;
  /** The thread waits on a child thread's request, which also wakes a snoozed thread. */
  readonly childWaits: boolean;
}

/**
 * A failure after the snooze began wakes the thread for its own alert, as `isSnoozed` does for
 * the latest run, also once a later run such as a queued wake started.
 */
const failureWakes = (
  subject: Pick<NewSubject, "source" | "kind" | "at">,
  shell: Pick<Shell, "snoozedAt">,
) => {
  if (subject.source !== "run" || subject.kind !== "failed") return false;
  const snoozedAt = millis(shell.snoozedAt);
  return snoozedAt === null || subject.at > snoozedAt;
};

/**
 * Whether a subject alerts now, waits for background work to free it, or never alerts. The same
 * rule decides when a subject is recorded, when held work ends and right before each delivery.
 */
export function subjectVerdict(
  subject: Pick<NewSubject, "id" | "source" | "kind" | "threadId" | "sourceThreadId" | "at"> & {
    readonly heldUntil?: number | null;
    /** It was recorded waiting for held work, within the window. */
    readonly waiting?: boolean;
  },
  state: SubjectState,
  nowMs: number,
): "alert" | "hold" | "drop" {
  if (subject.source === "digest") return "alert";
  const { shell } = state;
  if (shell === null || !isOpen(shell)) return "drop";
  // A child's request wakes a snoozed parent, as it does in the lists.
  const snoozed = !state.childWaits && !failureWakes(subject, shell) && isSnoozed(shell, nowMs);
  if (subject.source === "reminder") {
    return state.needOpen && !snoozed && subject.at >= nowMs - REMINDER_LATEST_MS
      ? "alert"
      : "drop";
  }
  const fresh = Math.max(subject.at, subject.heldUntil ?? 0) >= nowMs - NEEDS_YOU_ALERT_WINDOW_MS;
  if (!state.needOpen) return "drop";
  if (subject.source !== "run") {
    return !fresh || (snoozed && subject.sourceThreadId === subject.threadId) ? "drop" : "alert";
  }
  // The user acted on the thread after the run ended, or something stands in for it.
  const userWroteAfter = (millis(shell.latestUserAuthoredMessageAt) ?? 0) > subject.at;
  const settledAfter =
    shell.settledOverride === "settled" && (millis(shell.settledAt) ?? Infinity) >= subject.at;
  if (state.superseded || snoozed || userWroteAfter || settledAfter) return "drop";
  if (subject.kind === "failed") return fresh ? "alert" : "drop";
  const waits =
    ownNeedsYouRequest(shell) !== null ||
    state.childWaits ||
    (shell.openAsks?.length ?? 0) > 0 ||
    (shell.pendingGuestMessageCount ?? 0) > 0;
  if (waits || shell.settledOverride === "settled") return "drop";
  if (
    backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []) ||
    monitorHoldsWakeCompletion(shell)
  ) {
    // Once waiting it stays held however long the hold lasts, also across an outage longer than
    // the window; its window counts from when the hold ends.
    return fresh || subject.waiting === true ? "hold" : "drop";
  }
  // A hold that ended unseen, such as during an outage, counts its window from now.
  return fresh || subject.waiting === true ? "alert" : "drop";
}
