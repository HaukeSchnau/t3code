/**
 * Deterministic structural layout for the orchestration graph.
 *
 * No layout dependency: the graph we draw is a provenance tree (a coordinator
 * created workers, a worker created its own batch), and a tidy left-to-right
 * tree walk is both cheaper and more legible than a force simulation that
 * settles somewhere new on every render. The same input always produces the
 * same coordinates, so panning, selecting, and re-fetching never move a node.
 *
 * Depth is the column. Rows come from a post-order walk: leaves take the next
 * free row, parents centre on their children. Because a batch's members share a
 * parent and are walked together, a batch always occupies contiguous rows, which
 * is what makes the batch group boxes rectangles rather than blobs.
 */
export const GRAPH_NODE_WIDTH = 208;
export const GRAPH_NODE_HEIGHT = 62;
export const GRAPH_COLUMN_GAP = 92;
export const GRAPH_ROW_GAP = 18;
/** Room for the group box outline and its label above the first member. */
export const GRAPH_GROUP_PADDING = 10;
export const GRAPH_GROUP_HEADER = 20;
export const GRAPH_CANVAS_PADDING = 24;

export interface GraphNodeInput {
  readonly id: string;
  /** Structural parent. Null, or an id outside the set, makes this a root. */
  readonly parentId: string | null;
  /** Members of the same batch are laid out contiguously. */
  readonly batchId: string | null;
}

export interface GraphEdgeInput {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly structural: boolean;
}

export interface LaidOutNode {
  readonly id: string;
  readonly batchId: string | null;
  readonly depth: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LaidOutGroup {
  readonly batchId: string;
  readonly memberIds: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LaidOutEdge {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly structural: boolean;
  readonly path: string;
}

export interface GraphLayout {
  readonly nodes: readonly LaidOutNode[];
  readonly nodesById: ReadonlyMap<string, LaidOutNode>;
  readonly groups: readonly LaidOutGroup[];
  readonly edges: readonly LaidOutEdge[];
  readonly width: number;
  readonly height: number;
}

interface RowAssignment {
  readonly depth: number;
  readonly row: number;
}

/**
 * Orders a parent's children so batch members stay adjacent: batches keep the
 * order they were first seen in, and unbatched children trail them.
 */
function orderChildren(
  children: readonly GraphNodeInput[],
  indexById: ReadonlyMap<string, number>,
): readonly GraphNodeInput[] {
  const batchOrder = new Map<string, number>();
  for (const child of children) {
    if (child.batchId !== null && !batchOrder.has(child.batchId)) {
      batchOrder.set(child.batchId, batchOrder.size);
    }
  }
  return [...children].sort((left, right) => {
    const leftBatch =
      left.batchId === null ? Number.MAX_SAFE_INTEGER : batchOrder.get(left.batchId)!;
    const rightBatch =
      right.batchId === null ? Number.MAX_SAFE_INTEGER : batchOrder.get(right.batchId)!;
    if (leftBatch !== rightBatch) {
      return leftBatch - rightBatch;
    }
    return (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0);
  });
}

/** Right edge of a node box, where a structural edge leaves it. */
function exitPoint(node: LaidOutNode): { x: number; y: number } {
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

/** Left edge of a node box, where a structural edge lands. */
function entryPoint(node: LaidOutNode): { x: number; y: number } {
  return { x: node.x, y: node.y + node.height / 2 };
}

/**
 * Forward edges get an orthogonal elbow through the gutter between columns —
 * it reads as a tree. Anything that does not move rightwards (a message back to
 * the coordinator, a sibling handoff) bows out as a curve so it is obviously
 * not provenance.
 */
function edgePath(from: LaidOutNode, to: LaidOutNode): string {
  const start = exitPoint(from);
  const end = entryPoint(to);
  if (to.depth > from.depth) {
    const gutter = start.x + (end.x - start.x) / 2;
    return `M ${start.x} ${start.y} H ${gutter} V ${end.y} H ${end.x}`;
  }
  const back = { x: from.x, y: from.y + from.height / 2 };
  const target = { x: to.x + to.width, y: to.y + to.height / 2 };
  const bow = Math.max(48, Math.abs(target.y - back.y) / 2 + 32);
  const controlX = Math.min(back.x, target.x) - bow;
  return `M ${back.x} ${back.y} C ${controlX} ${back.y}, ${controlX} ${target.y}, ${target.x} ${target.y}`;
}

/**
 * Lays out a provenance graph. Cycles and repeated parents are tolerated: the
 * first placement of a node wins, so a malformed edge set degrades to a missing
 * line rather than a hang or a blank canvas.
 */
export function layoutOrchestrationGraph(input: {
  readonly nodes: readonly GraphNodeInput[];
  readonly edges: readonly GraphEdgeInput[];
}): GraphLayout {
  const indexById = new Map(input.nodes.map((node, index) => [node.id, index] as const));
  const byId = new Map(input.nodes.map((node) => [node.id, node] as const));
  const childrenByParent = new Map<string, GraphNodeInput[]>();
  const roots: GraphNodeInput[] = [];

  for (const node of input.nodes) {
    const parentId = node.parentId;
    if (parentId === null || parentId === node.id || !byId.has(parentId)) {
      roots.push(node);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings) {
      siblings.push(node);
    } else {
      childrenByParent.set(parentId, [node]);
    }
  }

  const assignments = new Map<string, RowAssignment>();
  const visited = new Set<string>();
  let nextRow = 0;

  /** Post-order: leaves consume rows, parents centre between their children. */
  const place = (node: GraphNodeInput, depth: number): number => {
    if (visited.has(node.id)) {
      return assignments.get(node.id)?.row ?? 0;
    }
    visited.add(node.id);
    const children = orderChildren(childrenByParent.get(node.id) ?? [], indexById);
    const childRows: number[] = [];
    for (const child of children) {
      childRows.push(place(child, depth + 1));
    }
    const row =
      childRows.length === 0 ? nextRow++ : (Math.min(...childRows) + Math.max(...childRows)) / 2;
    assignments.set(node.id, { depth, row });
    return row;
  };

  for (const root of roots) {
    place(root, 0);
  }
  // Anything only reachable through a cycle still deserves a position.
  for (const node of input.nodes) {
    if (!visited.has(node.id)) {
      place(node, 0);
    }
  }

  const nodes: LaidOutNode[] = input.nodes.map((node) => {
    const assignment = assignments.get(node.id) ?? { depth: 0, row: 0 };
    return {
      id: node.id,
      batchId: node.batchId,
      depth: assignment.depth,
      row: assignment.row,
      x: GRAPH_CANVAS_PADDING + assignment.depth * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
      y:
        GRAPH_CANVAS_PADDING +
        GRAPH_GROUP_HEADER +
        assignment.row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
    };
  });

  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));

  const groupMembers = new Map<string, LaidOutNode[]>();
  for (const node of nodes) {
    if (node.batchId === null) {
      continue;
    }
    const members = groupMembers.get(node.batchId);
    if (members) {
      members.push(node);
    } else {
      groupMembers.set(node.batchId, [node]);
    }
  }

  const groups: LaidOutGroup[] = [...groupMembers.entries()].map(([batchId, members]) => {
    const left = Math.min(...members.map((member) => member.x));
    const top = Math.min(...members.map((member) => member.y));
    const right = Math.max(...members.map((member) => member.x + member.width));
    const bottom = Math.max(...members.map((member) => member.y + member.height));
    return {
      batchId,
      memberIds: members.map((member) => member.id),
      x: left - GRAPH_GROUP_PADDING,
      y: top - GRAPH_GROUP_PADDING - GRAPH_GROUP_HEADER,
      width: right - left + GRAPH_GROUP_PADDING * 2,
      height: bottom - top + GRAPH_GROUP_PADDING * 2 + GRAPH_GROUP_HEADER,
    };
  });

  const edges: LaidOutEdge[] = [];
  for (const edge of input.edges) {
    const from = nodesById.get(edge.fromId);
    const to = nodesById.get(edge.toId);
    if (!from || !to || from.id === to.id) {
      continue;
    }
    edges.push({
      id: edge.id,
      fromId: edge.fromId,
      toId: edge.toId,
      structural: edge.structural,
      path: edgePath(from, to),
    });
  }

  const rightmost = nodes.reduce((max, node) => Math.max(max, node.x + node.width), 0);
  const lowest = nodes.reduce((max, node) => Math.max(max, node.y + node.height), 0);

  return {
    nodes,
    nodesById,
    groups,
    edges,
    width: rightmost + GRAPH_CANVAS_PADDING,
    height: lowest + GRAPH_CANVAS_PADDING,
  };
}
