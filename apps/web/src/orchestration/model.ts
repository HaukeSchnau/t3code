/**
 * Client view model for durable multi-model thread orchestration.
 *
 * A **batch** is the exact set of durable worker threads a coordinator launched
 * together under one server-issued `batchId`. A **barrier** is the server-owned
 * wait over that exact set: it reports every member's terminal disposition and
 * wakes the coordinator once.
 *
 * The wire shapes below mirror the contract additions proposed to the platform
 * side (`ThreadOrchestrationBatch` and friends). They are declared structurally
 * so the generated contract types assign to them without a rewrite here; when
 * the contract lands, these interfaces are the only thing to delete.
 *
 * Everything the UI renders comes out of `deriveBatchViews`. Components stay
 * dumb: no status arithmetic, no formatting, no "is this really running" logic
 * below this file.
 */
import { formatSubagentModelLabel } from "@t3tools/client-runtime/state/subagentRuntime";

/**
 * Honest worker state. `blocked` means the worker cannot progress without
 * someone acting (approval, user input, missing credential) — it is deliberately
 * distinct from `running` so a stuck fleet never reads as a busy one. `timedOut`
 * is the barrier's verdict, not the worker's.
 */
export const WORKER_STATES = [
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "timedOut",
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

const SETTLED_STATES = new Set<WorkerState>(["completed", "failed", "cancelled", "timedOut"]);

export function isSettledWorkerState(state: WorkerState): boolean {
  return SETTLED_STATES.has(state);
}

export type BarrierStatus = "open" | "satisfied" | "timedOut" | "cancelled";

export interface OrchestrationUsageWire {
  readonly totalTokens: number;
  readonly turns: number;
}

export interface OrchestrationDiffStatWire {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface OrchestrationWorkerWire {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  /** Role inside the batch ("risk-first", "control", …). Distinguishes A/B arms. */
  readonly role: string | null;
  readonly state: WorkerState;
  readonly model: string | null;
  readonly effort: string | null;
  /** Environment label. Cross-host lineage is visible or it does not exist. */
  readonly hostLabel: string;
  readonly workspaceRoot: string;
  /**
   * Whether the worker got its own checkout. First-class rather than inferred
   * from a null path: parallel arms writing one working tree is a correctness
   * hazard, and it deserves a badge, not an absence.
   */
  readonly workspaceIsolation: "shared" | "worktree";
  /** The worker's own worktree, when it has one. */
  readonly worktreePath: string | null;
  readonly startedAt: string | null;
  readonly settledAt: string | null;
  /** Why it is blocked, or why it failed. Never invented from the state alone. */
  readonly reason: string | null;
  /** Latest assistant result, server-truncated. */
  readonly summary: string | null;
  readonly usage: OrchestrationUsageWire | null;
  readonly diffStat: OrchestrationDiffStatWire | null;
}

export interface OrchestrationBarrierWire {
  readonly status: BarrierStatus;
  /** When the barrier resolved over the full member set. */
  readonly resolvedAt: string | null;
  /** When the coordinator was woken. Exactly once, or never yet. */
  readonly notifiedAt: string | null;
  /** Deadline the barrier will give up at, when one was set. */
  readonly deadlineAt: string | null;
}

export interface OrchestrationBatchWire {
  readonly batchId: string;
  readonly coordinatorEnvironmentId: string;
  readonly coordinatorThreadId: string;
  readonly title: string;
  /** The instruction the batch was launched with, so a card can show *why*. */
  readonly intent: string | null;
  readonly createdAt: string;
  readonly barrier: OrchestrationBarrierWire;
  readonly members: readonly OrchestrationWorkerWire[];
}

export interface OrchestrationCoordinatorWire {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly hostLabel: string;
}

/** Provenance and communication between durable threads. */
export type OrchestrationEdgeKind = "createdBy" | "forkedFrom" | "messagedBy" | "readBy";

export interface OrchestrationEdgeWire {
  readonly kind: OrchestrationEdgeKind;
  readonly actorEnvironmentId: string;
  readonly actorThreadId: string;
  readonly targetEnvironmentId: string;
  readonly targetThreadId: string;
  /** Set when the edge is the provenance of a batch launch. */
  readonly batchId: string | null;
  readonly createdAt: string;
}

export interface OrchestrationSnapshotWire {
  readonly coordinators: readonly OrchestrationCoordinatorWire[];
  readonly batches: readonly OrchestrationBatchWire[];
  readonly edges: readonly OrchestrationEdgeWire[];
}

/** Structural edges carry provenance; communication edges are opt-in noise. */
export function isStructuralEdgeKind(kind: OrchestrationEdgeKind): boolean {
  return kind === "createdBy" || kind === "forkedFrom";
}

export interface WorkerView {
  readonly key: string;
  readonly batchId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly role: string | null;
  readonly state: WorkerState;
  readonly settled: boolean;
  /** "opus-5 · high", or null when the provider never reported one. */
  readonly modelLabel: string | null;
  readonly hostLabel: string;
  /** Basename of whichever checkout the worker actually runs in. */
  readonly workspaceLabel: string;
  readonly isolated: boolean;
  readonly startedAt: string | null;
  readonly settledAt: string | null;
  readonly durationMs: number | null;
  readonly reason: string | null;
  readonly summary: string | null;
  readonly usage: OrchestrationUsageWire | null;
  readonly diffStat: OrchestrationDiffStatWire | null;
}

export interface BatchTally {
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly blocked: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly settled: number;
  readonly outstanding: number;
}

/**
 * What the batch needs from the user right now, in one word.
 * `attention` outranks `working`: a blocked member is the only thing on this
 * card a person can act on, so it must not hide behind busy siblings.
 */
export type BatchPhase = "launching" | "working" | "attention" | "settled";

export interface BatchView {
  readonly batchId: string;
  /** Stable, short, human-quotable. Batch ids are opaque and long. */
  readonly shortId: string;
  readonly title: string;
  readonly intent: string | null;
  readonly createdAt: string;
  readonly coordinatorEnvironmentId: string;
  readonly coordinatorThreadId: string;
  readonly barrier: OrchestrationBarrierWire;
  readonly workers: readonly WorkerView[];
  readonly tally: BatchTally;
  readonly phase: BatchPhase;
  /** One line for the card: what the barrier is doing about this batch. */
  readonly barrierLabel: string;
  /** Every worker settled *and* the coordinator has been woken. */
  readonly comparable: boolean;
}

export function workerKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

/** Last path segment, which is the only part of a checkout path worth a column. */
export function workspaceBasename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

function durationMsOf(worker: OrchestrationWorkerWire, now: number): number | null {
  if (!worker.startedAt) {
    return null;
  }
  const start = Date.parse(worker.startedAt);
  if (Number.isNaN(start)) {
    return null;
  }
  const end = worker.settledAt ? Date.parse(worker.settledAt) : now;
  if (Number.isNaN(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

export function deriveWorkerView(
  batchId: string,
  worker: OrchestrationWorkerWire,
  now: number,
): WorkerView {
  return {
    key: workerKey(worker.environmentId, worker.threadId),
    batchId,
    environmentId: worker.environmentId,
    threadId: worker.threadId,
    title: worker.title,
    role: worker.role,
    state: worker.state,
    settled: isSettledWorkerState(worker.state),
    modelLabel: formatSubagentModelLabel(worker.model, worker.effort),
    hostLabel: worker.hostLabel,
    workspaceLabel: workspaceBasename(worker.worktreePath ?? worker.workspaceRoot),
    isolated: worker.workspaceIsolation === "worktree",
    startedAt: worker.startedAt,
    settledAt: worker.settledAt,
    durationMs: durationMsOf(worker, now),
    reason: worker.reason,
    summary: worker.summary,
    usage: worker.usage,
    diffStat: worker.diffStat,
  };
}

export function tallyWorkers(workers: readonly WorkerView[]): BatchTally {
  const counts = {
    queued: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
  };
  for (const worker of workers) {
    counts[worker.state] += 1;
  }
  const settled = counts.completed + counts.failed + counts.cancelled + counts.timedOut;
  return {
    ...counts,
    total: workers.length,
    settled,
    outstanding: workers.length - settled,
  };
}

export function batchPhase(tally: BatchTally): BatchPhase {
  if (tally.total === 0 || tally.outstanding === 0) {
    return "settled";
  }
  if (tally.blocked > 0) {
    return "attention";
  }
  if (tally.running > 0) {
    return "working";
  }
  return "launching";
}

/**
 * The barrier's own story, never re-derived from member states. An open barrier
 * over a fully settled set is a real (and important) condition: the members are
 * done and the coordinator has not been woken yet.
 */
export function barrierLabel(barrier: OrchestrationBarrierWire, tally: BatchTally): string {
  switch (barrier.status) {
    case "open":
      return tally.outstanding === 0
        ? `All ${tally.total} reported · waking coordinator`
        : `Waiting on ${tally.outstanding} of ${tally.total}`;
    case "satisfied":
      return barrier.notifiedAt
        ? `Woke coordinator · ${tally.total} reported`
        : `All ${tally.total} reported`;
    case "timedOut":
      return tally.outstanding > 0
        ? `Timed out · ${tally.outstanding} of ${tally.total} never reported`
        : `Timed out · ${tally.total} reported`;
    case "cancelled":
      return `Cancelled · ${tally.settled} of ${tally.total} reported`;
  }
}

/** Batch ids are server-issued and opaque; cards quote the tail. */
export function shortBatchId(batchId: string): string {
  const tail =
    batchId
      .split(/[:/-]/)
      .filter((part) => part.length > 0)
      .at(-1) ?? batchId;
  return tail.slice(0, 6);
}

export function deriveBatchView(batch: OrchestrationBatchWire, now: number): BatchView {
  const workers = batch.members.map((member) => deriveWorkerView(batch.batchId, member, now));
  const tally = tallyWorkers(workers);
  return {
    batchId: batch.batchId,
    shortId: shortBatchId(batch.batchId),
    title: batch.title,
    intent: batch.intent,
    createdAt: batch.createdAt,
    coordinatorEnvironmentId: batch.coordinatorEnvironmentId,
    coordinatorThreadId: batch.coordinatorThreadId,
    barrier: batch.barrier,
    workers,
    tally,
    phase: batchPhase(tally),
    barrierLabel: barrierLabel(batch.barrier, tally),
    comparable: tally.outstanding === 0 && tally.completed >= 2,
  };
}

/**
 * Newest batch first — a coordinator's current batch is the one it is waiting
 * on, and scrolling to reach it is a bug.
 */
export function deriveBatchViews(
  batches: readonly OrchestrationBatchWire[],
  now: number,
): readonly BatchView[] {
  return [...batches]
    .map((batch) => deriveBatchView(batch, now))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function findWorker(
  batches: readonly BatchView[],
  key: string,
): { batch: BatchView; worker: WorkerView } | null {
  for (const batch of batches) {
    const worker = batch.workers.find((candidate) => candidate.key === key);
    if (worker) {
      return { batch, worker };
    }
  }
  return null;
}

export function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) {
    return null;
  }
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
