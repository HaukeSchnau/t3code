/**
 * Translates the server's batch contract into the view model in `model.ts`.
 *
 * The input interfaces mirror `ThreadOrchestrationBatch`, `…BatchMember` and
 * `…Relationship` structurally, so the generated contract types assign to them
 * once the platform side lands. Branded ids widen to `string`, optional keys
 * stay optional, and nothing here imports the contract package — that is what
 * lets the UI ship ahead of the wire.
 *
 * Every judgement call the UI would otherwise improvise lives here, and each
 * one is deliberate:
 *
 * - The **barrier keeps its own story**. Its status comes from the batch, never
 *   from counting members, so "all reported, coordinator not yet woken" stays
 *   visible instead of being smoothed into "done".
 * - **Member states are never rewritten to match the barrier.** A worker still
 *   running under a timed-out or cancelled barrier is reported as running,
 *   because on a batch spanning two hosts that is exactly what it is doing.
 *   The barrier line says the barrier gave up; the roster says who never came
 *   back. Collapsing the two would hide the cross-host case entirely.
 * - **Nothing is invented.** Fields the contract does not carry (per-worker
 *   usage, diff stats, failure reasons) arrive as `null` and render as absent.
 */
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";

import {
  workerKey,
  type BarrierStatus,
  type OrchestrationBatchWire,
  type OrchestrationCoordinatorWire,
  type OrchestrationEdgeKind,
  type OrchestrationEdgeWire,
  type OrchestrationSnapshotWire,
  type OrchestrationWorkerWire,
  type WorkerState,
} from "./model";

/**
 * `ModelSelection`, narrowed to the two fields a roster row shows. The option
 * value mirrors `ProviderOptionSelection` exactly — widening it to `unknown`
 * would read as tolerant but only moves the cast into the call site.
 */
export interface BatchContractModelSelection {
  readonly model: string;
  readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
}

export type BatchContractOutcome =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "blocked-approval"
  | "blocked-input";

/** `ThreadOrchestrationThreadSummary`, narrowed to what orchestration renders. */
export interface BatchContractThread {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly outcome: BatchContractOutcome;
  readonly modelSelection: BatchContractModelSelection;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `ThreadOrchestrationBatchMember`. */
export interface BatchContractMember {
  readonly label: string;
  readonly workspaceIsolation: "shared" | "worktree";
  readonly thread: BatchContractThread;
  readonly latestAssistantMessage: { readonly text: string } | null;
}

export type BatchContractStatus =
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "deadline-exceeded";

/** `ThreadOrchestrationBatch`. */
export interface BatchContractBatch {
  readonly batchId: string;
  readonly coordinatorEnvironmentId: string;
  readonly coordinatorThreadId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: BatchContractStatus;
  readonly members: readonly BatchContractMember[];
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  readonly settledAt: string | null;
  readonly notifiedAt: string | null;
}

/** `ThreadOrchestrationRelationship`. */
export interface BatchContractRelationship {
  readonly kind: "createdBy" | "forkedFrom" | "readBy" | "messagedBy" | "renamedBy";
  readonly actorEnvironmentId?: string;
  readonly actorThreadId: string;
  readonly targetEnvironmentId?: string;
  readonly targetThreadId: string;
  readonly batchId?: string;
  readonly createdAt: string;
}

export interface OrchestrationAdapterInput {
  readonly batches: readonly BatchContractBatch[];
  /** `ThreadOrchestrationThreadGraphResult`, when the graph was fetched. */
  readonly graph: {
    readonly nodes: readonly BatchContractThread[];
    readonly edges: readonly BatchContractRelationship[];
  } | null;
  /** Environment id → the label the connection list shows for that host. */
  readonly environmentLabels: ReadonlyMap<string, string>;
  /**
   * The environment the snapshot was fetched from. Relationship edges omit
   * their environment when it is the local one, and a missing host has to
   * resolve to a real environment rather than to a guess.
   */
  readonly localEnvironmentId: string;
}

/**
 * The batch reports a thread outcome; the roster reports a worker state.
 * `blocked-*` collapses to one `blocked` state because the difference between
 * "needs an approval" and "needs an answer" belongs in the reason line, not in
 * the vocabulary every consumer has to switch over. `interrupted` is a
 * cancellation: something stopped the worker, it did not decide to stop.
 */
export function workerStateFromOutcome(outcome: BatchContractOutcome): WorkerState {
  switch (outcome) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "cancelled";
    case "blocked-approval":
    case "blocked-input":
      return "blocked";
  }
}

/**
 * Restates the blocking outcome, which is a fact the server sent, rather than
 * guessing a cause from a generic `blocked`. Every other state has no reason
 * the contract can supply, so it gets none.
 */
function reasonFromOutcome(outcome: BatchContractOutcome): string | null {
  switch (outcome) {
    case "blocked-approval":
      return "Waiting on an approval";
    case "blocked-input":
      return "Waiting on your input";
    default:
      return null;
  }
}

/**
 * The barrier's status, which is about the *wait*, not about the members.
 * `blocked` maps to `open` on purpose: a fleet stuck on one approval is a
 * liveness problem, not a disposition, and the barrier has not resolved.
 * `failed` still satisfies the barrier — every member reported, and some
 * reported badly.
 */
export function barrierStatusFromBatchStatus(status: BatchContractStatus): BarrierStatus {
  switch (status) {
    case "running":
    case "blocked":
      return "open";
    case "completed":
    case "failed":
      return "satisfied";
    case "cancelled":
      return "cancelled";
    case "deadline-exceeded":
      return "timedOut";
  }
}

const SETTLED_OUTCOMES = new Set<BatchContractOutcome>(["completed", "failed", "interrupted"]);

function hostLabelFor(input: OrchestrationAdapterInput, environmentId: string): string {
  // An unlabelled environment prints its id tail rather than "this machine":
  // claiming the wrong host on a cross-host batch is worse than being terse.
  return input.environmentLabels.get(environmentId) ?? environmentId.slice(0, 8);
}

function memberToWorker(
  input: OrchestrationAdapterInput,
  member: BatchContractMember,
): OrchestrationWorkerWire {
  const { thread } = member;
  const settled = SETTLED_OUTCOMES.has(thread.outcome);
  return {
    environmentId: thread.environmentId,
    threadId: thread.threadId,
    title: thread.title,
    role: member.label,
    state: workerStateFromOutcome(thread.outcome),
    model: thread.modelSelection.model,
    effort: getProviderOptionStringSelectionValue(thread.modelSelection.options, "effort") ?? null,
    hostLabel: hostLabelFor(input, thread.environmentId),
    workspaceRoot: thread.workspaceRoot,
    workspaceIsolation: member.workspaceIsolation,
    worktreePath: thread.worktreePath,
    // Thread timestamps are the closest thing the contract carries to a run
    // window. `updatedAt` is only a settle time once the thread has settled;
    // on a live worker it is just the last edit, so it stays null and the
    // duration counts against now.
    startedAt: thread.createdAt,
    settledAt: settled ? thread.updatedAt : null,
    reason: reasonFromOutcome(thread.outcome),
    summary: member.latestAssistantMessage?.text ?? null,
    // Not on the wire yet. Absent, never zero: a zero would read as "spent
    // nothing" instead of "we were not told".
    usage: null,
    diffStat: null,
  };
}

export function batchToWire(
  input: OrchestrationAdapterInput,
  batch: BatchContractBatch,
): OrchestrationBatchWire {
  return {
    batchId: batch.batchId,
    coordinatorEnvironmentId: batch.coordinatorEnvironmentId,
    coordinatorThreadId: batch.coordinatorThreadId,
    title: batch.title,
    intent: batch.prompt,
    createdAt: batch.createdAt,
    barrier: {
      status: barrierStatusFromBatchStatus(batch.status),
      resolvedAt: batch.settledAt,
      notifiedAt: batch.notifiedAt,
      deadlineAt: batch.deadlineAt,
    },
    members: batch.members.map((member) => memberToWorker(input, member)),
  };
}

/** `renamedBy` is neither provenance nor a message, so the graph has no line for it. */
function edgeKindOf(kind: BatchContractRelationship["kind"]): OrchestrationEdgeKind | null {
  return kind === "renamedBy" ? null : kind;
}

/**
 * Coordinators the graph can name. Only threads that actually coordinate a
 * batch qualify — the thread graph also returns threads that merely read or
 * messaged one, and drawing those as coordinators would invent a hierarchy.
 */
function coordinatorsOf(input: OrchestrationAdapterInput): readonly OrchestrationCoordinatorWire[] {
  const wanted = new Set(
    input.batches.map((batch) =>
      workerKey(batch.coordinatorEnvironmentId, batch.coordinatorThreadId),
    ),
  );
  const coordinators: OrchestrationCoordinatorWire[] = [];
  for (const node of input.graph?.nodes ?? []) {
    const key = workerKey(node.environmentId, node.threadId);
    if (!wanted.delete(key)) {
      continue;
    }
    coordinators.push({
      environmentId: node.environmentId,
      threadId: node.threadId,
      title: node.title,
      hostLabel: hostLabelFor(input, node.environmentId),
    });
  }
  // A coordinator the graph never described still anchors its batch; the graph
  // model fills in a placeholder title rather than dropping the whole subtree.
  for (const key of wanted) {
    const batch = input.batches.find(
      (candidate) =>
        workerKey(candidate.coordinatorEnvironmentId, candidate.coordinatorThreadId) === key,
    );
    if (!batch) {
      continue;
    }
    coordinators.push({
      environmentId: batch.coordinatorEnvironmentId,
      threadId: batch.coordinatorThreadId,
      title: batch.title,
      hostLabel: hostLabelFor(input, batch.coordinatorEnvironmentId),
    });
  }
  return coordinators;
}

function edgesOf(input: OrchestrationAdapterInput): readonly OrchestrationEdgeWire[] {
  const edges: OrchestrationEdgeWire[] = [];
  for (const edge of input.graph?.edges ?? []) {
    const kind = edgeKindOf(edge.kind);
    if (!kind) {
      continue;
    }
    edges.push({
      kind,
      actorEnvironmentId: edge.actorEnvironmentId ?? input.localEnvironmentId,
      actorThreadId: edge.actorThreadId,
      targetEnvironmentId: edge.targetEnvironmentId ?? input.localEnvironmentId,
      targetThreadId: edge.targetThreadId,
      batchId: edge.batchId ?? null,
      createdAt: edge.createdAt,
    });
  }
  return edges;
}

export function toOrchestrationSnapshot(
  input: OrchestrationAdapterInput,
): OrchestrationSnapshotWire {
  return {
    coordinators: coordinatorsOf(input),
    batches: input.batches.map((batch) => batchToWire(input, batch)),
    edges: edgesOf(input),
  };
}

export const EMPTY_ORCHESTRATION_SNAPSHOT: OrchestrationSnapshotWire = {
  coordinators: [],
  batches: [],
  edges: [],
};
