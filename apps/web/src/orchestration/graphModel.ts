/**
 * Turns an orchestration snapshot into the node and edge inputs the layout
 * consumes, plus the presentation each node renders.
 *
 * Batch membership is the authoritative provenance: a worker's structural
 * parent is the coordinator that launched its batch. Relationship edges only
 * supply what membership cannot — forks, and threads reached outside a batch.
 * A thread that is both a worker and a coordinator is one node, which is what
 * makes a nested batch draw as a third column instead of a duplicate root.
 */
import { formatSubagentModelLabel } from "@t3tools/client-runtime/state/subagentRuntime";

import {
  isStructuralEdgeKind,
  workerKey,
  workspaceBasename,
  type OrchestrationEdgeKind,
  type OrchestrationSnapshotWire,
  type WorkerState,
} from "./model";
import type { GraphEdgeInput, GraphNodeInput } from "./graphLayout";

export interface GraphNodeDescriptor {
  readonly id: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly role: string | null;
  /** Null on a coordinator that is not itself somebody's worker. */
  readonly state: WorkerState | null;
  readonly batchId: string | null;
  readonly modelLabel: string | null;
  readonly hostLabel: string;
  readonly workspaceLabel: string | null;
  /** False when the worker shares another thread's checkout. */
  readonly isolated: boolean;
  readonly isCoordinator: boolean;
}

export interface GraphEdgeDescriptor extends GraphEdgeInput {
  readonly kind: OrchestrationEdgeKind;
}

export interface OrchestrationGraphModel {
  readonly nodes: readonly GraphNodeInput[];
  readonly edges: readonly GraphEdgeDescriptor[];
  readonly descriptorsById: ReadonlyMap<string, GraphNodeDescriptor>;
  /** Batch id → the node id of the coordinator that launched it. */
  readonly coordinatorByBatchId: ReadonlyMap<string, string>;
}

export function buildOrchestrationGraphModel(
  snapshot: OrchestrationSnapshotWire,
): OrchestrationGraphModel {
  const descriptors = new Map<string, GraphNodeDescriptor>();
  const parentByNodeId = new Map<string, string>();
  const coordinatorByBatchId = new Map<string, string>();
  /** Input order drives sibling order, so nodes are collected, not sorted. */
  const order: string[] = [];

  const remember = (descriptor: GraphNodeDescriptor) => {
    if (!descriptors.has(descriptor.id)) {
      order.push(descriptor.id);
    }
    descriptors.set(descriptor.id, descriptor);
  };

  for (const coordinator of snapshot.coordinators) {
    const id = workerKey(coordinator.environmentId, coordinator.threadId);
    remember({
      id,
      environmentId: coordinator.environmentId,
      threadId: coordinator.threadId,
      title: coordinator.title,
      role: null,
      state: null,
      batchId: null,
      modelLabel: null,
      hostLabel: coordinator.hostLabel,
      workspaceLabel: null,
      isolated: true,
      isCoordinator: true,
    });
  }

  for (const batch of snapshot.batches) {
    const coordinatorId = workerKey(batch.coordinatorEnvironmentId, batch.coordinatorThreadId);
    coordinatorByBatchId.set(batch.batchId, coordinatorId);
    if (!descriptors.has(coordinatorId)) {
      // A coordinator the snapshot did not describe still anchors its batch.
      remember({
        id: coordinatorId,
        environmentId: batch.coordinatorEnvironmentId,
        threadId: batch.coordinatorThreadId,
        title: "Coordinator",
        role: null,
        state: null,
        batchId: null,
        modelLabel: null,
        hostLabel: "",
        workspaceLabel: null,
        isolated: true,
        isCoordinator: true,
      });
    }
    for (const member of batch.members) {
      const id = workerKey(member.environmentId, member.threadId);
      const existing = descriptors.get(id);
      remember({
        id,
        environmentId: member.environmentId,
        threadId: member.threadId,
        title: member.title,
        role: member.role,
        state: member.state,
        batchId: batch.batchId,
        modelLabel: formatSubagentModelLabel(member.model, member.effort),
        hostLabel: member.hostLabel,
        workspaceLabel: workspaceBasename(member.worktreePath ?? member.workspaceRoot),
        isolated: member.workspaceIsolation === "worktree",
        // A worker that launched its own batch keeps its coordinator role.
        isCoordinator: existing?.isCoordinator ?? false,
      });
      parentByNodeId.set(id, coordinatorId);
    }
  }

  // Coordinators of nested batches are coordinators even if they were only
  // seen as members above.
  for (const [, coordinatorId] of coordinatorByBatchId) {
    const descriptor = descriptors.get(coordinatorId);
    if (descriptor && !descriptor.isCoordinator) {
      descriptors.set(coordinatorId, { ...descriptor, isCoordinator: true });
    }
  }

  const edges: GraphEdgeDescriptor[] = [];
  for (const edge of snapshot.edges) {
    const fromId = workerKey(edge.actorEnvironmentId, edge.actorThreadId);
    const toId = workerKey(edge.targetEnvironmentId, edge.targetThreadId);
    if (!descriptors.has(fromId) || !descriptors.has(toId) || fromId === toId) {
      continue;
    }
    const structural = isStructuralEdgeKind(edge.kind);
    // Provenance the batch did not already supply (a fork, a one-off spawn).
    if (structural && !parentByNodeId.has(toId)) {
      parentByNodeId.set(toId, fromId);
    }
    edges.push({
      id: `${edge.kind}:${fromId}->${toId}:${edge.createdAt}`,
      fromId,
      toId,
      structural,
      kind: edge.kind,
    });
  }

  const nodes: GraphNodeInput[] = order.map((id) => {
    const descriptor = descriptors.get(id)!;
    return {
      id,
      parentId: parentByNodeId.get(id) ?? null,
      batchId: descriptor.batchId,
    };
  });

  return { nodes, edges, descriptorsById: descriptors, coordinatorByBatchId };
}
