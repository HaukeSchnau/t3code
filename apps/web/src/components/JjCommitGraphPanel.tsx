import type {
  ContextMenuItem,
  EnvironmentId,
  GitCommitGraphAction,
  GitCommitGraphNode as GitCommitGraphNodeContract,
  GitCommitGraphResult as GitCommitGraphResultContract,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { prepareFileTreeInput, type GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  BaseEdge,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  useNodesState,
  Position,
  Handle,
  PanOnScrollMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitForkIcon,
  Loader2Icon,
  MapIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  gitCommitGraphActionMutationOptions,
  gitChangeDiffQueryOptions,
  gitCommitGraphQueryOptions,
  gitThreadChangesQueryOptions,
  GIT_COMMIT_GRAPH_DEFAULT_LIMIT,
} from "~/lib/gitReactQuery";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getRenderablePatch, resolveFileDiffPath } from "~/lib/renderablePatch";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";

type GraphNodeData = {
  readonly node: GitCommitGraphNodeContract;
  readonly turnFocused: boolean;
  readonly turnDimmed: boolean;
};

type ActionDialogKind =
  | "describe"
  | "new"
  | "insert_after"
  | "insert_before"
  | "abandon"
  | "duplicate"
  | "rebase"
  | "squash"
  | "split"
  | "bookmark_set"
  | "bookmark_move"
  | "bookmark_rename"
  | "bookmark_delete"
  | "bookmark_track"
  | "bookmark_untrack";

type GraphCommand = ActionDialogKind | "edit" | "copy_change_id" | "copy_commit_id";
type GraphContextMenuCommand = GraphCommand | `${string}:submenu`;

interface JjCommitGraphPanelProps {
  environmentId: EnvironmentId;
  cwd: string | null;
  threadId?: ThreadId | undefined;
  focusTurnId?: TurnId | undefined;
  initialChangeId?: string | undefined;
  mode: "sidebar" | "sheet";
  onClose: () => void;
}

const JJ_GRAPH_CURRENT_LINE_REVSET = "first_ancestors(@, 80) | @";
const JJ_GRAPH_REVSET_PRESETS = [
  { label: "Recent", revset: null },
  { label: "Line", revset: JJ_GRAPH_CURRENT_LINE_REVSET },
  { label: "Ancestors", revset: "ancestors(@, 80)" },
] as const;
const GRAPH_COMPONENT_GAP = 180;
const GRAPH_NODE_WIDTH = 160;
const GRAPH_NODE_HEIGHT = 96;
const GRAPH_ROW_GAP = 128;
const GRAPH_NODE_X = 16;
const GRAPH_LANE_GAP = 168;
const GRAPH_RECENT_NODE_COUNT = 10;
const GRAPH_LAYOUT_TRANSITION_MS = 220;
const GRAPH_LAZY_LOAD_BATCH_SIZE = 150;
const GRAPH_LAZY_LOAD_PARENT_COUNT = 12;
const GRAPH_LAZY_LOAD_THRESHOLD_PX = 900;
const GRAPH_CONTEXT_MENU_ITEMS = [
  { id: "edit", label: "Edit change" },
  { id: "describe", label: "Describe…" },
  { id: "new", label: "New child…" },
  {
    id: "insert:submenu",
    label: "Insert change",
    children: [
      { id: "insert_after", label: "After selected…" },
      { id: "insert_before", label: "Before selected…" },
    ],
  },
  {
    id: "copy:submenu",
    label: "Copy",
    children: [
      { id: "copy_change_id", label: "Change ID" },
      { id: "copy_commit_id", label: "Commit ID" },
    ],
  },
  {
    id: "bookmark:submenu",
    label: "Bookmark",
    children: [
      { id: "bookmark_set", label: "Set…" },
      { id: "bookmark_move", label: "Move here…" },
      { id: "bookmark_rename", label: "Rename…" },
      { id: "bookmark_delete", label: "Delete…", destructive: true },
      { id: "bookmark_track", label: "Track remote…" },
      { id: "bookmark_untrack", label: "Untrack remote…" },
    ],
  },
  {
    id: "rewrite:submenu",
    label: "Rewrite",
    children: [
      { id: "duplicate", label: "Duplicate…" },
      { id: "rebase", label: "Rebase…" },
      { id: "squash", label: "Squash…" },
      { id: "split", label: "Split…" },
      { id: "abandon", label: "Abandon…", destructive: true },
    ],
  },
] satisfies readonly ContextMenuItem<GraphContextMenuCommand>[];

type GraphEdgeKind = "spine" | "branch" | "merge";
type GraphEdgeData = {
  readonly kind: GraphEdgeKind;
  readonly selectedRelated: boolean;
};
type GraphViewport = {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
};

function graphEdgeKey(changeId: string, parentChangeId: string): string {
  return `${changeId}:${parentChangeId}`;
}

function mergeCommitGraphPages(
  baseGraph: GitCommitGraphResultContract | undefined,
  pages: readonly GitCommitGraphResultContract[],
): GitCommitGraphResultContract | undefined {
  if (!baseGraph) return undefined;
  const nodesByChangeId = new Map<string, GitCommitGraphNodeContract>();
  const edgesByKey = new Map<string, GitCommitGraphResultContract["edges"][number]>();
  for (const graph of [baseGraph, ...pages]) {
    for (const node of graph.nodes) {
      if (!nodesByChangeId.has(node.changeId)) {
        nodesByChangeId.set(node.changeId, node);
      }
    }
    for (const edge of graph.edges) {
      edgesByKey.set(graphEdgeKey(edge.fromChangeId, edge.toChangeId), edge);
    }
  }
  return {
    ...baseGraph,
    hasMore: pages.some((page) => page.hasMore),
    nodes: Array.from(nodesByChangeId.values()),
    edges: Array.from(edgesByKey.values()),
  };
}

function resolveNextHistoryRevset(nodes: readonly GitCommitGraphNodeContract[]): string | null {
  const loadedChangeIds = new Set(nodes.map((node) => node.changeId));
  const missingParentChangeIds: string[] = [];
  const seenMissingParentChangeIds = new Set<string>();
  for (const node of nodes) {
    for (const parentChangeId of node.parentChangeIds) {
      if (loadedChangeIds.has(parentChangeId) || seenMissingParentChangeIds.has(parentChangeId)) {
        continue;
      }
      seenMissingParentChangeIds.add(parentChangeId);
      missingParentChangeIds.push(parentChangeId);
      if (missingParentChangeIds.length >= GRAPH_LAZY_LOAD_PARENT_COUNT) break;
    }
    if (missingParentChangeIds.length >= GRAPH_LAZY_LOAD_PARENT_COUNT) break;
  }
  if (missingParentChangeIds.length === 0) return null;
  return `ancestors((${missingParentChangeIds.join(" | ")}), ${GRAPH_LAZY_LOAD_BATCH_SIZE + 1})`;
}

function resolveMissingParentHistoryRevset(params: {
  nodes: readonly GitCommitGraphNodeContract[];
  changeIds: readonly string[];
}): string | null {
  const loadedChangeIds = new Set(params.nodes.map((node) => node.changeId));
  const nodesByChangeId = new Map(params.nodes.map((node) => [node.changeId, node]));
  const missingParentChangeIds: string[] = [];
  const seenMissingParentChangeIds = new Set<string>();

  for (const changeId of params.changeIds) {
    const node = nodesByChangeId.get(changeId);
    if (!node) continue;
    for (const parentChangeId of node.parentChangeIds) {
      if (loadedChangeIds.has(parentChangeId) || seenMissingParentChangeIds.has(parentChangeId)) {
        continue;
      }
      seenMissingParentChangeIds.add(parentChangeId);
      missingParentChangeIds.push(parentChangeId);
      if (missingParentChangeIds.length >= GRAPH_LAZY_LOAD_PARENT_COUNT) break;
    }
    if (missingParentChangeIds.length >= GRAPH_LAZY_LOAD_PARENT_COUNT) break;
  }

  if (missingParentChangeIds.length === 0) return null;
  return `ancestors((${missingParentChangeIds.join(" | ")}), ${GRAPH_LAZY_LOAD_BATCH_SIZE + 1})`;
}

function resolveViewportHistoryRevset(params: {
  flowNodes: readonly Node<GraphNodeData>[];
  viewport: GraphViewport;
  viewportElement: HTMLElement;
}): string | null {
  const loadedChangeIds = new Set(params.flowNodes.map((node) => node.id));
  const viewportTop = -params.viewport.y / params.viewport.zoom - GRAPH_LAZY_LOAD_THRESHOLD_PX;
  const viewportBottom =
    (params.viewportElement.clientHeight - params.viewport.y) / params.viewport.zoom +
    GRAPH_LAZY_LOAD_THRESHOLD_PX;
  const viewportLeft = -params.viewport.x / params.viewport.zoom - GRAPH_LAZY_LOAD_THRESHOLD_PX;
  const viewportRight =
    (params.viewportElement.clientWidth - params.viewport.x) / params.viewport.zoom +
    GRAPH_LAZY_LOAD_THRESHOLD_PX;
  const visibleMissingParentChangeIds: string[] = [];
  const seenMissingParentChangeIds = new Set<string>();
  const sortedFlowNodes = params.flowNodes.toSorted((left, right) => {
    const leftDistance = Math.max(
      0,
      left.position.y - viewportBottom,
      viewportTop - left.position.y,
    );
    const rightDistance = Math.max(
      0,
      right.position.y - viewportBottom,
      viewportTop - right.position.y,
    );
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return left.position.y - right.position.y;
  });

  for (const flowNode of sortedFlowNodes) {
    const nodeLeft = flowNode.position.x;
    const nodeRight = flowNode.position.x + GRAPH_NODE_WIDTH;
    const nodeTop = flowNode.position.y;
    const nodeBottom = flowNode.position.y + GRAPH_NODE_HEIGHT;
    const nearViewport =
      nodeRight >= viewportLeft &&
      nodeLeft <= viewportRight &&
      nodeBottom >= viewportTop &&
      nodeTop <= viewportBottom;
    if (!nearViewport) continue;

    for (const parentChangeId of flowNode.data.node.parentChangeIds) {
      if (loadedChangeIds.has(parentChangeId) || seenMissingParentChangeIds.has(parentChangeId)) {
        continue;
      }
      seenMissingParentChangeIds.add(parentChangeId);
      visibleMissingParentChangeIds.push(parentChangeId);
      if (visibleMissingParentChangeIds.length >= GRAPH_LAZY_LOAD_PARENT_COUNT) break;
    }
    if (visibleMissingParentChangeIds.length >= GRAPH_LAZY_LOAD_PARENT_COUNT) break;
  }

  if (visibleMissingParentChangeIds.length === 0) return null;
  return `ancestors((${visibleMissingParentChangeIds.join(" | ")}), ${
    GRAPH_LAZY_LOAD_BATCH_SIZE + 1
  })`;
}

function enforceAncestorRows(params: {
  componentNodes: readonly GitCommitGraphNodeContract[];
  componentIds: ReadonlySet<string>;
  rowByChangeId: Map<string, number>;
}): boolean {
  let changed = false;
  for (const node of params.componentNodes) {
    const childRow = params.rowByChangeId.get(node.changeId) ?? 0;
    for (const parentChangeId of node.parentChangeIds) {
      if (!params.componentIds.has(parentChangeId)) continue;
      const parentRow = params.rowByChangeId.get(parentChangeId) ?? 0;
      const nextParentRow = Math.max(parentRow, childRow + 1);
      if (nextParentRow !== parentRow) {
        params.rowByChangeId.set(parentChangeId, nextParentRow);
        changed = true;
      }
    }
  }
  return changed;
}

function resolveLaneRowCollisions(params: {
  componentNodes: readonly GitCommitGraphNodeContract[];
  indexByChangeId: ReadonlyMap<string, number>;
  laneByChangeId: ReadonlyMap<string, number>;
  rowByChangeId: Map<string, number>;
}): boolean {
  let changed = false;
  const occupiedCells = new Set<string>();
  const nodesByVisualOrder = params.componentNodes.toSorted((left, right) => {
    const leftRow = params.rowByChangeId.get(left.changeId) ?? 0;
    const rightRow = params.rowByChangeId.get(right.changeId) ?? 0;
    if (leftRow !== rightRow) return leftRow - rightRow;
    const leftLane = params.laneByChangeId.get(left.changeId) ?? 0;
    const rightLane = params.laneByChangeId.get(right.changeId) ?? 0;
    if (leftLane !== rightLane) return leftLane - rightLane;
    return (
      (params.indexByChangeId.get(left.changeId) ?? 0) -
      (params.indexByChangeId.get(right.changeId) ?? 0)
    );
  });

  for (const node of nodesByVisualOrder) {
    const lane = params.laneByChangeId.get(node.changeId) ?? 0;
    let row = params.rowByChangeId.get(node.changeId) ?? 0;
    while (occupiedCells.has(`${lane}:${row}`)) {
      row++;
      changed = true;
    }
    params.rowByChangeId.set(node.changeId, row);
    occupiedCells.add(`${lane}:${row}`);
  }
  return changed;
}

function buildGraphLayout(nodes: readonly GitCommitGraphNodeContract[]): {
  positions: Map<string, { x: number; y: number }>;
  edgeKinds: Map<string, GraphEdgeKind>;
  currentLineNodeIds: string[];
  recentNodeIds: string[];
} {
  const nodesByChangeId = new Map(nodes.map((node) => [node.changeId, node]));
  const indexByChangeId = new Map(nodes.map((node, index) => [node.changeId, index]));
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    for (const parentChangeId of node.parentChangeIds) {
      if (!nodesByChangeId.has(parentChangeId)) continue;
      const children = childrenByParent.get(parentChangeId) ?? [];
      children.push(node.changeId);
      childrenByParent.set(parentChangeId, children);
    }
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (visited.has(node.changeId)) continue;
    const component: string[] = [];
    const stack = [node.changeId];
    visited.add(node.changeId);
    while (stack.length > 0) {
      const changeId = stack.pop()!;
      component.push(changeId);
      const graphNode = nodesByChangeId.get(changeId);
      const neighbors = [
        ...(graphNode?.parentChangeIds.filter((parent) => nodesByChangeId.has(parent)) ?? []),
        ...(childrenByParent.get(changeId) ?? []),
      ];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(component);
  }

  const currentChangeId = nodes.find((node) => node.currentWorkingCopy)?.changeId ?? null;
  const currentLineNodeIds: string[] = [];
  const visitedCurrentLineIds = new Set<string>();
  let nextCurrentLineId = currentChangeId;
  while (
    nextCurrentLineId &&
    nodesByChangeId.has(nextCurrentLineId) &&
    !visitedCurrentLineIds.has(nextCurrentLineId)
  ) {
    currentLineNodeIds.push(nextCurrentLineId);
    visitedCurrentLineIds.add(nextCurrentLineId);
    const firstParentChangeId = nodesByChangeId.get(nextCurrentLineId)?.parentChangeIds[0] ?? null;
    nextCurrentLineId =
      firstParentChangeId && nodesByChangeId.has(firstParentChangeId) ? firstParentChangeId : null;
  }

  components.sort((left, right) => {
    const leftIndex = Math.min(
      ...left.map((changeId) => indexByChangeId.get(changeId) ?? Infinity),
    );
    const rightIndex = Math.min(
      ...right.map((changeId) => indexByChangeId.get(changeId) ?? Infinity),
    );
    return leftIndex - rightIndex;
  });

  const positions = new Map<string, { x: number; y: number }>();
  const edgeKinds = new Map<string, GraphEdgeKind>();
  let componentOffsetX = 0;
  for (const component of components) {
    const componentIds = new Set(component);
    const componentNodes = component
      .map((changeId) => nodesByChangeId.get(changeId)!)
      .toSorted(
        (left, right) => indexByChangeId.get(left.changeId)! - indexByChangeId.get(right.changeId)!,
      );
    const laneByChangeId = new Map<string, number>();
    const rowByChangeId = new Map<string, number>();
    let activeLanes: string[] = [];

    for (const node of componentNodes) {
      const activeLane = activeLanes.indexOf(node.changeId);
      const lane = activeLane >= 0 ? activeLane : activeLanes.length;
      laneByChangeId.set(node.changeId, lane);

      const loadedParentChangeIds = node.parentChangeIds.filter((parentChangeId) =>
        componentIds.has(parentChangeId),
      );
      loadedParentChangeIds.forEach((parentChangeId, parentIndex) => {
        const isFirstParent = parentIndex === 0;
        const isCurrentLineEdge =
          isFirstParent &&
          currentLineNodeIds.includes(node.changeId) &&
          currentLineNodeIds.includes(parentChangeId);
        edgeKinds.set(
          graphEdgeKey(node.changeId, parentChangeId),
          isCurrentLineEdge ? "spine" : isFirstParent ? "branch" : "merge",
        );
      });

      if (activeLane >= 0) {
        activeLanes.splice(activeLane, 1, ...loadedParentChangeIds);
      } else {
        activeLanes.splice(lane, 0, ...loadedParentChangeIds);
      }
      const seenActiveLaneIds = new Set<string>();
      activeLanes = activeLanes.filter((activeChangeId) => {
        if (seenActiveLaneIds.has(activeChangeId)) return false;
        seenActiveLaneIds.add(activeChangeId);
        return true;
      });
    }

    const maxLayoutIterations = componentNodes.length * componentNodes.length;
    for (let iteration = 0; iteration < maxLayoutIterations; iteration++) {
      const ancestorRowsChanged = enforceAncestorRows({
        componentNodes,
        componentIds,
        rowByChangeId,
      });
      const collisionsChanged = resolveLaneRowCollisions({
        componentNodes,
        indexByChangeId,
        laneByChangeId,
        rowByChangeId,
      });
      if (!ancestorRowsChanged && !collisionsChanged) break;
    }

    let maxLane = 0;
    componentNodes.forEach((node) => {
      const lane = laneByChangeId.get(node.changeId) ?? 0;
      const row = rowByChangeId.get(node.changeId) ?? 0;
      maxLane = Math.max(maxLane, lane);
      positions.set(node.changeId, {
        x: componentOffsetX + GRAPH_NODE_X + lane * GRAPH_LANE_GAP,
        y: row * GRAPH_ROW_GAP,
      });
    });

    componentOffsetX += (maxLane + 1) * GRAPH_LANE_GAP + GRAPH_COMPONENT_GAP;
  }

  return {
    positions,
    edgeKinds,
    currentLineNodeIds,
    recentNodeIds: nodes.slice(0, GRAPH_RECENT_NODE_COUNT).map((node) => node.changeId),
  };
}

function buildFlowGraph(input: {
  nodes: readonly GitCommitGraphNodeContract[];
  focusedChangeIds?: ReadonlySet<string> | undefined;
  selectedChangeId?: string | null | undefined;
}): {
  nodes: Node<GraphNodeData>[];
  edges: Edge[];
  currentLineNodeIds: string[];
  recentNodeIds: string[];
} {
  const { positions, edgeKinds, currentLineNodeIds, recentNodeIds } = buildGraphLayout(input.nodes);
  const nodeIds = new Set(input.nodes.map((node) => node.changeId));
  const hasFocusedTurn = input.focusedChangeIds !== undefined && input.focusedChangeIds.size > 0;
  const flowNodes: Node<GraphNodeData>[] = input.nodes.map((node) => ({
    id: node.changeId,
    type: "jjCommit",
    className: "jj-commit-graph-flow-node",
    data: {
      node,
      turnFocused: input.focusedChangeIds?.has(node.changeId) ?? false,
      turnDimmed: hasFocusedTurn && !(input.focusedChangeIds?.has(node.changeId) ?? false),
    },
    position: positions.get(node.changeId) ?? { x: 0, y: 0 },
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  }));
  const flowEdges: Edge[] = input.nodes.flatMap((node) =>
    node.parentChangeIds
      .filter((parentChangeId) => nodeIds.has(parentChangeId))
      .map((parentChangeId) => {
        const edgeKind = edgeKinds.get(graphEdgeKey(node.changeId, parentChangeId)) ?? "branch";
        const selectedRelated =
          input.selectedChangeId === node.changeId || input.selectedChangeId === parentChangeId;
        return {
          id: graphEdgeKey(node.changeId, parentChangeId),
          source: node.changeId,
          target: parentChangeId,
          type: "jjCommit",
          className: cn(
            "jj-commit-graph-edge",
            edgeKind === "merge" && "jj-commit-graph-edge-merge",
          ),
          data: {
            kind: edgeKind,
            selectedRelated,
          } satisfies GraphEdgeData,
          style: {
            strokeWidth: edgeKind === "spine" || selectedRelated ? 2.25 : 1.25,
            opacity: edgeKind === "spine" || selectedRelated ? 0.95 : 0.7,
          },
        };
      }),
  );
  return { nodes: flowNodes, edges: flowEdges, currentLineNodeIds, recentNodeIds };
}

function JjCommitGraphEdge(props: EdgeProps) {
  const data = props.data as GraphEdgeData | undefined;
  const kind = data?.kind ?? "branch";
  const selectedRelated = data?.selectedRelated ?? false;
  const verticalDistance = Math.max(0, props.targetY - props.sourceY);
  const sourceX =
    kind === "merge"
      ? props.sourceX + Math.sign(props.targetX - props.sourceX || 1) * 10
      : props.sourceX;
  const mergeFanoutOffset = Math.min(
    Math.max(28, verticalDistance * 0.18),
    Math.max(28, Math.min(72, verticalDistance - 18)),
  );
  const midY =
    kind === "merge"
      ? props.sourceY + mergeFanoutOffset
      : props.sourceY + Math.max(22, verticalDistance / 2);
  const path = [
    `M ${sourceX} ${props.sourceY}`,
    `L ${sourceX} ${midY}`,
    `L ${props.targetX} ${midY}`,
    `L ${props.targetX} ${props.targetY}`,
  ].join(" ");

  return (
    <BaseEdge
      id={props.id}
      className={cn("jj-commit-graph-edge", kind === "merge" && "jj-commit-graph-edge-merge")}
      path={path}
      style={{
        stroke: kind === "spine" || selectedRelated ? "var(--primary)" : "var(--muted-foreground)",
        strokeWidth: kind === "spine" || selectedRelated ? 2.5 : 1.35,
        opacity: kind === "spine" || selectedRelated ? 0.95 : 0.72,
      }}
    />
  );
}

const JjCommitNode = memo(function JjCommitNode({
  data,
  selected,
}: NodeProps<Node<GraphNodeData>>) {
  const node = data.node;
  const description = node.description || "(no description set)";
  const authorLabel = node.authorName || node.authorEmail || "Unknown author";
  const authorTitle = node.authorEmail ? `${authorLabel} <${node.authorEmail}>` : authorLabel;
  const bookmarks = [
    ...node.localBookmarks.map((bookmark, index) => ({
      bookmark,
      key: `local-${index}-${bookmark}`,
      label: bookmark,
    })),
    ...node.remoteBookmarks.map((bookmark, index) => ({
      bookmark,
      key: `remote-${index}-${bookmark}`,
      label: bookmark,
    })),
  ];
  const visibleBookmarks = bookmarks.slice(0, 2);
  const hiddenBookmarkCount = Math.max(0, bookmarks.length - visibleBookmarks.length);
  return (
    <div
      style={{ contain: "layout paint style", height: GRAPH_NODE_HEIGHT }}
      className={cn(
        "w-40 overflow-hidden rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-sm transition-colors",
        selected ? "border-primary shadow-primary/15" : "border-border/80",
        node.currentWorkingCopy && "ring-2 ring-primary/35",
        data.turnFocused && "ring-2 ring-amber-400/55",
        data.turnDimmed && "opacity-35",
      )}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="flex h-full items-start gap-2">
        <span
          className={cn(
            "mt-1 size-2.5 shrink-0 rounded-full",
            node.currentWorkingCopy
              ? "bg-primary"
              : node.conflict
                ? "bg-destructive"
                : "bg-muted-foreground/50",
          )}
        />
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium">{description}</div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-muted-foreground text-xs">
            {node.currentWorkingCopy ? (
              <span className="shrink-0 rounded bg-primary px-1 font-medium text-primary-foreground">
                @
              </span>
            ) : null}
            <span className="shrink-0">{node.displayChangeId}</span>
            <span className="shrink-0">{node.shortCommitId}</span>
            {node.empty ? <span className="shrink-0 rounded bg-muted px-1">empty</span> : null}
            {node.wip ? (
              <span className="shrink-0 rounded bg-amber-100 px-1 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                WIP
              </span>
            ) : null}
            {node.t3Links.length > 0 ? (
              <span className="shrink-0 rounded bg-sky-100 px-1 font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
                T3 {node.t3Links.length}
              </span>
            ) : null}
            {node.conflict ? (
              <span className="shrink-0 rounded bg-destructive/10 px-1 text-destructive">
                conflict
              </span>
            ) : null}
            {node.immutable ? (
              <span className="shrink-0 rounded bg-muted px-1">immutable</span>
            ) : null}
          </div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground" title={authorTitle}>
            {authorLabel}
          </div>
          {bookmarks.length > 0 ? (
            <div className="mt-auto flex h-5 min-w-0 items-center gap-1 overflow-hidden">
              {visibleBookmarks.map(({ key, label }) => (
                <span
                  key={key}
                  title={label}
                  className="inline-flex min-w-0 max-w-24 shrink items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-[10px] leading-none"
                >
                  <GitBranchIcon className="size-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
              ))}
              {hiddenBookmarkCount > 0 ? (
                <span className="shrink-0 rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  +{hiddenBookmarkCount}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
});

const nodeTypes = { jjCommit: JjCommitNode };
const edgeTypes = { jjCommit: JjCommitGraphEdge };

function isRiskyDialog(kind: ActionDialogKind): boolean {
  return [
    "abandon",
    "duplicate",
    "rebase",
    "squash",
    "split",
    "bookmark_move",
    "bookmark_rename",
    "bookmark_delete",
    "bookmark_track",
    "bookmark_untrack",
  ].includes(kind);
}

function isDialogCommand(command: GraphCommand): command is ActionDialogKind {
  return command !== "edit" && command !== "copy_change_id" && command !== "copy_commit_id";
}

function isGraphCommand(command: GraphContextMenuCommand): command is GraphCommand {
  return !command.endsWith(":submenu");
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']") !== null
  );
}

function commandForGraphKey(event: ReactKeyboardEvent<HTMLElement>): GraphCommand | null {
  const key = event.key;
  const normalizedKey = key.toLowerCase();

  if ((event.metaKey || event.ctrlKey) && normalizedKey !== "c") {
    return null;
  }
  if (event.altKey) {
    return null;
  }

  if (normalizedKey === "c") {
    return event.shiftKey ? "copy_commit_id" : "copy_change_id";
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    return null;
  }

  switch (normalizedKey) {
    case "enter":
    case "e":
      return "edit";
    case "d":
      return "describe";
    case "n":
      return "new";
    case "a":
      return "insert_after";
    case "b":
      return "insert_before";
    case "m":
      return "bookmark_set";
    case "r":
      return "rebase";
    case "s":
      return "squash";
    case "x":
      return "split";
    case "backspace":
    case "delete":
      return "abandon";
    default:
      return null;
  }
}

function shellQuote(value: string): string {
  return value.length === 0 || /[\s'"$\\]/.test(value)
    ? `'${value.replace(/'/g, "'\\''")}'`
    : value;
}

function previewActionCommand(
  kind: ActionDialogKind,
  selected: GitCommitGraphNodeContract,
  form: Record<string, string>,
): string {
  switch (kind) {
    case "describe":
      return `jj describe -r ${selected.changeId} -m ${shellQuote(form.message ?? selected.description ?? "")}`;
    case "new":
      return `jj new ${selected.changeId}${form.message ? ` -m ${shellQuote(form.message)}` : ""}`;
    case "insert_after":
      return `jj new -A ${selected.changeId}${form.message ? ` -m ${shellQuote(form.message)}` : ""}`;
    case "insert_before":
      return `jj new -B ${selected.changeId}${form.message ? ` -m ${shellQuote(form.message)}` : ""}`;
    case "abandon":
      return `jj abandon ${selected.changeId}`;
    case "duplicate":
      return `jj duplicate ${selected.changeId}`;
    case "rebase":
      return `jj rebase -s ${selected.changeId} -o ${form.destinationChangeId || "<destination>"}`;
    case "squash":
      return `jj squash --from ${selected.changeId} --into ${form.intoChangeId || "<destination>"}`;
    case "split":
      return `jj split -r ${selected.changeId} ${(form.filesets || "<filesets>").trim()}`;
    case "bookmark_set":
      return `jj bookmark set ${form.bookmarkName || "<name>"} -r ${selected.changeId}`;
    case "bookmark_move":
      return `jj bookmark move ${form.bookmarkName || "<name>"} --to ${selected.changeId}`;
    case "bookmark_rename":
      return `jj bookmark rename ${form.oldName || "<old>"} ${form.newName || "<new>"}`;
    case "bookmark_delete":
      return `jj bookmark delete ${form.bookmarkName || "<name>"}`;
    case "bookmark_track":
      return `jj bookmark track ${form.bookmarkName || "<name>"}@${form.remote || "<remote>"}`;
    case "bookmark_untrack":
      return `jj bookmark untrack ${form.bookmarkName || "<name>"}@${form.remote || "<remote>"}`;
  }
}

function actionFromDialog(
  kind: ActionDialogKind,
  selected: GitCommitGraphNodeContract,
  form: Record<string, string>,
): GitCommitGraphAction {
  switch (kind) {
    case "describe":
      return {
        kind: "describe",
        changeId: selected.changeId,
        message: form.message ?? selected.description ?? "",
      };
    case "new":
      return {
        kind: "new",
        parentChangeIds: [selected.changeId],
        ...(form.message ? { message: form.message } : {}),
      };
    case "insert_after":
      return {
        kind: "insert_new",
        changeId: selected.changeId,
        position: "after",
        ...(form.message ? { message: form.message } : {}),
      };
    case "insert_before":
      return {
        kind: "insert_new",
        changeId: selected.changeId,
        position: "before",
        ...(form.message ? { message: form.message } : {}),
      };
    case "abandon":
      return { kind: "abandon", changeIds: [selected.changeId], confirmed: true };
    case "duplicate":
      return { kind: "duplicate", changeIds: [selected.changeId], confirmed: true };
    case "rebase":
      return {
        kind: "rebase",
        mode: "source",
        revset: selected.changeId,
        destinationMode: "onto",
        destinationChangeIds: [form.destinationChangeId ?? ""],
        confirmed: true,
      };
    case "squash":
      return {
        kind: "squash",
        fromChangeId: selected.changeId,
        intoChangeId: form.intoChangeId ?? "",
        confirmed: true,
      };
    case "split":
      return {
        kind: "split",
        changeId: selected.changeId,
        filesets: (form.filesets ?? "").split(/\s+/).filter(Boolean),
        confirmed: true,
      };
    case "bookmark_set":
      return { kind: "bookmark_set", name: form.bookmarkName ?? "", changeId: selected.changeId };
    case "bookmark_move":
      return {
        kind: "bookmark_move",
        name: form.bookmarkName ?? "",
        changeId: selected.changeId,
        confirmed: true,
      };
    case "bookmark_rename":
      return {
        kind: "bookmark_rename",
        oldName: form.oldName ?? "",
        newName: form.newName ?? "",
        confirmed: true,
      };
    case "bookmark_delete":
      return { kind: "bookmark_delete", name: form.bookmarkName ?? "", confirmed: true };
    case "bookmark_track":
      return {
        kind: "bookmark_track",
        name: form.bookmarkName ?? "",
        remote: form.remote ?? "",
        confirmed: true,
      };
    case "bookmark_untrack":
      return {
        kind: "bookmark_untrack",
        name: form.bookmarkName ?? "",
        remote: form.remote ?? "",
        confirmed: true,
      };
  }
}

function JjCommitGraphActionDialog(props: {
  kind: ActionDialogKind | null;
  selected: GitCommitGraphNodeContract | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (action: GitCommitGraphAction) => void;
}) {
  const { kind, selected } = props;
  const [form, setForm] = useState<Record<string, string>>({});
  const open = kind !== null && selected !== null;
  const setField =
    (field: string) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((previous) => ({ ...previous, [field]: event.target.value }));
  const commandPreview = kind && selected ? previewActionCommand(kind, selected, form) : "";
  const title = kind ? kind.replace(/_/g, " ") : "JJ action";
  const needsMessage =
    kind === "describe" || kind === "new" || kind === "insert_after" || kind === "insert_before";
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setForm({});
          props.onClose();
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="capitalize">{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {needsMessage ? (
            <label className="grid gap-1.5 text-sm">
              Message
              <Textarea
                value={form.message ?? selected?.description ?? ""}
                onChange={setField("message")}
              />
            </label>
          ) : null}
          {kind === "bookmark_set" ||
          kind === "bookmark_move" ||
          kind === "bookmark_delete" ||
          kind === "bookmark_track" ||
          kind === "bookmark_untrack" ? (
            <label className="grid gap-1.5 text-sm">
              Bookmark
              <Input
                value={form.bookmarkName ?? selected?.localBookmarks[0] ?? ""}
                onChange={setField("bookmarkName")}
              />
            </label>
          ) : null}
          {kind === "bookmark_rename" ? (
            <>
              <label className="grid gap-1.5 text-sm">
                Old bookmark
                <Input
                  value={form.oldName ?? selected?.localBookmarks[0] ?? ""}
                  onChange={setField("oldName")}
                />
              </label>
              <label className="grid gap-1.5 text-sm">
                New bookmark
                <Input value={form.newName ?? ""} onChange={setField("newName")} />
              </label>
            </>
          ) : null}
          {kind === "bookmark_track" || kind === "bookmark_untrack" ? (
            <label className="grid gap-1.5 text-sm">
              Remote
              <Input value={form.remote ?? "origin"} onChange={setField("remote")} />
            </label>
          ) : null}
          {kind === "rebase" ? (
            <label className="grid gap-1.5 text-sm">
              Destination change
              <Input
                value={form.destinationChangeId ?? ""}
                onChange={setField("destinationChangeId")}
              />
            </label>
          ) : null}
          {kind === "squash" ? (
            <label className="grid gap-1.5 text-sm">
              Squash into change
              <Input value={form.intoChangeId ?? ""} onChange={setField("intoChangeId")} />
            </label>
          ) : null}
          {kind === "split" ? (
            <label className="grid gap-1.5 text-sm">
              Filesets
              <Input
                value={form.filesets ?? ""}
                onChange={setField("filesets")}
                placeholder="src/file.ts docs/*.md"
              />
            </label>
          ) : null}
          <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
            {commandPreview}
          </div>
          {kind && isRiskyDialog(kind) ? (
            <p className="text-muted-foreground text-xs">
              This rewrites local JJ history. The operation log can recover mistakes with `jj op
              log` and `jj op restore`.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!kind || !selected || props.pending}
            onClick={() => {
              if (!kind || !selected) return;
              props.onSubmit(actionFromDialog(kind, selected, form));
              setForm({});
            }}
          >
            {props.pending ? <Loader2Icon className="animate-spin" /> : null}
            Run
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type JjGraphChangedFileEntry = {
  readonly path: string;
  readonly status: GitStatusEntry["status"];
};

const EMPTY_DIFF_FILES: readonly FileDiffMetadata[] = [];
const REVIEW_SPLIT_STORAGE_KEY = "t3code:jj-graph:review-split";
const DEFAULT_GRAPH_REVIEW_SPLIT = 38;
const MIN_GRAPH_REVIEW_SPLIT = 22;
const MAX_GRAPH_REVIEW_SPLIT = 74;
const graphTimestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getGraphTimestampFormatter(timestampFormat: TimestampFormat): Intl.DateTimeFormat {
  const cachedFormatter = graphTimestampFormatterCache.get(timestampFormat);
  if (cachedFormatter) return cachedFormatter;

  const formatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timestampFormat === "locale" ? {} : { hour12: timestampFormat === "12-hour" }),
  });
  graphTimestampFormatterCache.set(timestampFormat, formatter);
  return formatter;
}

function formatGraphCommitTimestamp(value: string, timestampFormat: TimestampFormat): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return getGraphTimestampFormatter(timestampFormat).format(parsed);
}

function formatGraphCwdLabel(cwd: string | null): string {
  if (!cwd) return "No repository selected";
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

const JJ_GRAPH_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-bg-muted-override: color-mix(in lab, var(--trees-accent) 7%, transparent);
    --trees-fg-override: var(--foreground);
    --trees-fg-muted-override: var(--muted-foreground);
    --trees-border-color-override: var(--border);
    --trees-accent-override: var(--primary);
    --trees-selected-bg-override: color-mix(in lab, var(--primary) 12%, transparent);
    --trees-selected-focused-border-color-override: var(--primary);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 11px;
    --trees-border-radius-override: 6px;
    --trees-level-gap-override: 8px;
    --trees-item-padding-x-override: 6px;
    --trees-item-margin-x-override: 2px;
    --trees-padding-inline-override: 4px;
  }
`;

const JJ_GRAPH_DIFF_UNSAFE_CSS = `
  :host {
    --diffs-bg-override: transparent;
    --diffs-font-family-override: var(--font-mono);
    --diffs-font-size-override: 11px;
    --diffs-line-height-override: 1.45;
  }
`;

function normalizeJjSummaryPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"');
  }
  return trimmed;
}

function mapJjSummaryStatus(status: string): GitStatusEntry["status"] {
  if (status.includes("D")) return "deleted";
  if (status.includes("A")) return "added";
  if (status.includes("R")) return "renamed";
  if (status.includes("?")) return "untracked";
  return "modified";
}

function parseJjChangedFilesSummary(summary: string | undefined): JjGraphChangedFileEntry[] {
  if (!summary?.trim()) return [];
  return summary
    .split("\n")
    .map((line): JjGraphChangedFileEntry | null => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const match = /^([A-Z?]+)\s+(.+)$/.exec(trimmed);
      if (!match) return null;
      return {
        path: normalizeJjSummaryPath(match[2] ?? ""),
        status: mapJjSummaryStatus(match[1] ?? ""),
      };
    })
    .filter((entry): entry is JjGraphChangedFileEntry => entry != null && entry.path.length > 0);
}

function stripLeadingRelativeSegments(path: string): string {
  let next = path;
  while (next.startsWith("../")) {
    next = next.slice(3);
  }
  return next;
}

function resolveCanonicalChangedPath(path: string, diffPaths: readonly string[]): string {
  const stripped = stripLeadingRelativeSegments(path);
  return (
    diffPaths.find(
      (diffPath) =>
        diffPath === path ||
        diffPath === stripped ||
        diffPath.endsWith(`/${path}`) ||
        diffPath.endsWith(`/${stripped}`),
    ) ?? path
  );
}

function buildChangedFileEntries(
  changedFilesSummary: string | undefined,
  diffFiles: readonly FileDiffMetadata[],
): JjGraphChangedFileEntry[] {
  const diffPaths = diffFiles.map((fileDiff) => resolveFileDiffPath(fileDiff)).filter(Boolean);
  const summaryEntries = parseJjChangedFilesSummary(changedFilesSummary).map((entry) => ({
    path: resolveCanonicalChangedPath(entry.path, diffPaths),
    status: entry.status,
  }));
  const statusByPath = new Map(summaryEntries.map((entry) => [entry.path, entry.status]));
  const entries = new Map<string, JjGraphChangedFileEntry>();

  for (const fileDiff of diffFiles) {
    const path = resolveFileDiffPath(fileDiff);
    if (!path) continue;
    entries.set(path, {
      path,
      status: statusByPath.get(path) ?? "modified",
    });
  }

  for (const entry of summaryEntries) {
    entries.set(entry.path, entry);
  }

  return Array.from(entries.values()).toSorted((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function JjChangeFileTree(props: {
  entries: readonly JjGraphChangedFileEntry[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  const paths = useMemo(() => props.entries.map((entry) => entry.path), [props.entries]);
  const preparedInput = useMemo(
    () => prepareFileTreeInput(paths, { flattenEmptyDirectories: true }),
    [paths],
  );
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => props.entries.map((entry) => ({ path: entry.path, status: entry.status })),
    [props.entries],
  );
  const initialSelectedPaths = props.selectedPath ? [props.selectedPath] : paths.slice(0, 1);
  const { model } = useFileTree({
    preparedInput,
    gitStatus,
    initialExpansion: 2,
    initialSelectedPaths,
    density: "compact",
    itemHeight: 24,
    overscan: 8,
    search: false,
    stickyFolders: false,
    unsafeCSS: JJ_GRAPH_TREE_UNSAFE_CSS,
    onSelectionChange: (selectedPaths) => {
      const nextPath = selectedPaths[0];
      if (nextPath) props.onSelectPath(nextPath);
    },
  });

  return <FileTree model={model} className="h-full min-h-0 w-full" />;
}

function buildJjGraphFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name ?? "none"}`;
}

function clampGraphReviewSplit(value: number): number {
  return Math.min(MAX_GRAPH_REVIEW_SPLIT, Math.max(MIN_GRAPH_REVIEW_SPLIT, value));
}

function readGraphReviewSplit(): number {
  if (typeof window === "undefined") return DEFAULT_GRAPH_REVIEW_SPLIT;
  try {
    const rawValue = window.localStorage.getItem(REVIEW_SPLIT_STORAGE_KEY);
    const parsed = rawValue ? Number.parseFloat(rawValue) : Number.NaN;
    return Number.isFinite(parsed) ? clampGraphReviewSplit(parsed) : DEFAULT_GRAPH_REVIEW_SPLIT;
  } catch {
    return DEFAULT_GRAPH_REVIEW_SPLIT;
  }
}

function JjCommitGraphInspector(props: {
  selected: GitCommitGraphNodeContract | null;
  environmentId: EnvironmentId;
  cwd: string | null;
  mode: "sidebar" | "sheet";
}) {
  const selected = props.selected;
  const { resolvedTheme } = useTheme();
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const changeDiffQuery = useQuery(
    gitChangeDiffQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      changeId: selected?.changeId ?? null,
    }),
  );
  useEffect(() => {
    setSelectedFilePath(null);
  }, [selected?.changeId]);
  const detail = changeDiffQuery.data;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(detail?.diff, `jj-graph:${selected?.changeId ?? "none"}:${resolvedTheme}`),
    [detail?.diff, resolvedTheme, selected?.changeId],
  );
  const diffFiles = useMemo(
    () => (renderablePatch?.kind === "files" ? renderablePatch.files : EMPTY_DIFF_FILES),
    [renderablePatch],
  );
  const changedFiles = useMemo(
    () =>
      buildChangedFileEntries(detail?.files.map((file) => `M ${file.path}`).join("\n"), diffFiles),
    [detail, diffFiles],
  );
  const effectiveSelectedFilePath =
    selectedFilePath && changedFiles.some((entry) => entry.path === selectedFilePath)
      ? selectedFilePath
      : (changedFiles[0]?.path ?? null);
  const selectedFileDiff =
    effectiveSelectedFilePath && renderablePatch?.kind === "files"
      ? (renderablePatch.files.find(
          (fileDiff) => resolveFileDiffPath(fileDiff) === effectiveSelectedFilePath,
        ) ?? null)
      : null;
  const treeKey = changedFiles.map((entry) => `${entry.status}:${entry.path}`).join("\0");
  const hasFiles = changedFiles.length > 0;
  const showFileTree = changedFiles.length > 1;
  const fileSummaryLabel = changeDiffQuery.isPending
    ? "Loading files..."
    : changeDiffQuery.isError
      ? "Files unavailable"
      : hasFiles
        ? `${changedFiles.length} ${changedFiles.length === 1 ? "file" : "files"} changed`
        : "No changed files";
  const commitTimestampLabel = selected
    ? formatGraphCommitTimestamp(selected.committerTimestamp, timestampFormat)
    : "";
  if (!selected) {
    return (
      <aside
        className={cn(
          "flex min-h-0 w-full flex-1 flex-col border-t border-border bg-background p-3 text-muted-foreground text-sm",
        )}
      >
        Select a change to inspect JJ metadata and actions.
      </aside>
    );
  }
  return (
    <aside
      className={cn("flex min-h-0 w-full flex-1 flex-col border-t border-border bg-background")}
    >
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <GitCommitHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />
          <h3 className="min-w-28 flex-1 truncate font-semibold text-sm">
            {selected.description || "(no description set)"}
          </h3>
          <div className="flex min-w-0 shrink-0 items-center gap-2 text-muted-foreground text-xs">
            <span className="hidden sm:inline">{selected.displayChangeId}</span>
            <span>{selected.shortCommitId}</span>
            <span className="hidden md:inline">·</span>
            <span className="hidden max-w-40 truncate md:inline">{fileSummaryLabel}</span>
            <span className="hidden lg:inline">·</span>
            <span className="hidden max-w-48 truncate lg:inline">
              {selected.authorName || "Unknown author"}
            </span>
            <span className="hidden xl:inline">·</span>
            <span className="hidden xl:inline" title={selected.committerTimestamp}>
              {commitTimestampLabel}
            </span>
          </div>
        </div>
        {selected.t3Links.length > 0 ? (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
            {selected.t3Links.slice(0, 4).map((link) => (
              <span
                key={`${link.threadId}:${link.turnId}:${link.role}`}
                className="rounded-md border border-border/70 bg-muted/30 px-1.5 py-0.5 text-muted-foreground"
                title={`thread ${link.threadId}\nturn ${link.turnId}\n${link.firstOperationId ?? "?"} -> ${
                  link.lastOperationId ?? "?"
                }`}
              >
                {link.role} · {link.turnId}
              </span>
            ))}
            {selected.t3Links.length > 4 ? (
              <span className="text-muted-foreground">+{selected.t3Links.length - 4}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <section className="grid min-h-0 flex-1 overflow-hidden" aria-label="Review">
            {changeDiffQuery.isPending ? (
              <div className="text-muted-foreground text-sm">Loading details...</div>
            ) : changeDiffQuery.isError ? (
              <div className="text-destructive text-sm">
                {changeDiffQuery.error instanceof Error
                  ? changeDiffQuery.error.message
                  : "JJ graph details unavailable."}
              </div>
            ) : detail?.tooLarge ? (
              <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-muted-foreground text-sm">
                This JJ diff is too large to render inline. Narrow the selection or open the change
                in your editor.
              </div>
            ) : changedFiles.length > 0 ? (
              <>
                <div
                  className={cn(
                    "grid h-full min-h-0 gap-2 overflow-hidden",
                    showFileTree
                      ? "lg:grid-cols-[minmax(180px,0.42fr)_minmax(0,1fr)]"
                      : "grid-cols-1",
                  )}
                >
                  {showFileTree ? (
                    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border/70 bg-muted/20">
                      <div className="flex items-center justify-between border-b border-border/70 px-2 py-1.5">
                        <span className="font-medium text-xs">{changedFiles.length} files</span>
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <JjChangeFileTree
                          key={treeKey}
                          entries={changedFiles}
                          selectedPath={effectiveSelectedFilePath}
                          onSelectPath={setSelectedFilePath}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="min-h-0 min-w-0 overflow-hidden">
                    {selectedFileDiff ? (
                      <div className="h-full min-h-0 overflow-auto rounded-md border border-border/70 bg-background/70">
                        <div
                          key={`${buildJjGraphFileDiffRenderKey(selectedFileDiff)}:${resolvedTheme}`}
                          className="diff-render-file min-h-full border-0"
                        >
                          <FileDiff
                            fileDiff={selectedFileDiff}
                            options={{
                              diffStyle: "unified",
                              lineDiffType: "none",
                              overflow: "wrap",
                              theme: resolveDiffThemeName(resolvedTheme),
                              themeType: resolvedTheme,
                              unsafeCSS: JJ_GRAPH_DIFF_UNSAFE_CSS,
                            }}
                          />
                        </div>
                      </div>
                    ) : renderablePatch?.kind === "raw" ? (
                      <div className="flex h-full min-h-0 flex-col space-y-1.5">
                        <p className="text-[11px] text-muted-foreground">
                          {renderablePatch.reason}
                        </p>
                        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border/70 bg-muted/30 p-2 font-mono text-[11px]">
                          {renderablePatch.text}
                        </pre>
                      </div>
                    ) : (
                      <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-muted-foreground text-xs">
                        No textual diff available for {effectiveSelectedFilePath ?? "this file"}.
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-muted-foreground text-sm">
                No changed files.
              </div>
            )}
          </section>
        </div>
      </div>
    </aside>
  );
}

export default function JjCommitGraphPanel({
  environmentId,
  cwd,
  threadId,
  focusTurnId,
  initialChangeId,
  mode,
  onClose,
}: JjCommitGraphPanelProps) {
  const queryClient = useQueryClient();
  const [revsetInput, setRevsetInput] = useState("");
  const [appliedRevset, setAppliedRevset] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [dialogKind, setDialogKind] = useState<ActionDialogKind | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [showRevsetEditor, setShowRevsetEditor] = useState(false);
  const [animateGraphLayout, setAnimateGraphLayout] = useState(false);
  const [graphHistoryPages, setGraphHistoryPages] = useState<GitCommitGraphResultContract[]>([]);
  const [isLoadingGraphHistory, setIsLoadingGraphHistory] = useState(false);
  const [graphReviewSplit, setGraphReviewSplit] = useState(readGraphReviewSplit);
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<Node<GraphNodeData>>([]);
  const graphReviewContainerRef = useRef<HTMLDivElement | null>(null);
  const graphReviewDragAbortRef = useRef<AbortController | null>(null);
  const graphKeyboardRef = useRef<HTMLDivElement | null>(null);
  const graphViewportRef = useRef<GraphViewport | null>(null);
  const selectedRef = useRef<GitCommitGraphNodeContract | null>(null);
  const selectedChangeIdRef = useRef<string | null>(null);
  const requestedHistoryRevsetsRef = useRef<Set<string>>(new Set());
  const hasRenderedGraphLayoutRef = useRef(false);
  const graphLayoutSignatureRef = useRef("");
  const graphLayoutTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadChangesQuery = useQuery(
    gitThreadChangesQueryOptions({
      environmentId,
      cwd,
      threadId: threadId ?? null,
      turnId: focusTurnId ?? null,
      enabled: Boolean(threadId && focusTurnId),
    }),
  );
  const focusedChangeIds = useMemo(() => {
    if (!focusTurnId) return new Set<string>();
    const links =
      threadChangesQuery.data?.turns.find((turn) => turn.turnId === focusTurnId)?.links ?? [];
    return new Set(links.map((link) => link.changeId));
  }, [focusTurnId, threadChangesQuery.data?.turns]);
  const graphQuery = useQuery(
    gitCommitGraphQueryOptions({
      environmentId,
      cwd,
      revset: appliedRevset,
      limit: GIT_COMMIT_GRAPH_DEFAULT_LIMIT,
      threadId: threadId ?? null,
      turnId: focusTurnId ?? null,
      changeIds: [...focusedChangeIds],
    }),
  );
  const actionMutation = useMutation(
    gitCommitGraphActionMutationOptions({ environmentId, cwd, queryClient }),
  );
  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: (label) => {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `${label} copied`,
          description: "Ready on your clipboard.",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Copy failed",
          description: error.message,
        }),
      );
    },
  });
  const baseGraph = graphQuery.data;
  const graph = useMemo(
    () => mergeCommitGraphPages(baseGraph, graphHistoryPages),
    [baseGraph, graphHistoryPages],
  );
  const activeRevsetPreset = JJ_GRAPH_REVSET_PRESETS.find(
    (preset) => preset.revset === appliedRevset,
  );
  const hasCustomRevset = appliedRevset !== null && !activeRevsetPreset;
  const graphResetKey = `${cwd ?? ""}:${baseGraph?.revset ?? ""}:${
    baseGraph?.currentOperationId ?? ""
  }:${focusTurnId ?? ""}:${[...focusedChangeIds].join(",")}`;
  useEffect(() => {
    setGraphHistoryPages([]);
    setIsLoadingGraphHistory(false);
    requestedHistoryRevsetsRef.current.clear();
  }, [graphResetKey]);
  const showCustomRevsetRow = showRevsetEditor || hasCustomRevset;
  const cwdLabel = formatGraphCwdLabel(cwd);
  const selected =
    graph?.nodes.find((node) => node.changeId === selectedChangeId) ??
    graph?.nodes.find((node) => node.currentWorkingCopy) ??
    graph?.nodes[0] ??
    null;
  useEffect(() => {
    selectedRef.current = selected;
    selectedChangeIdRef.current = selected?.changeId ?? null;
  }, [selected]);
  const flowGraph = useMemo(
    () =>
      buildFlowGraph({
        nodes: graph?.nodes ?? [],
        focusedChangeIds,
        selectedChangeId: selected?.changeId ?? null,
      }),
    [focusedChangeIds, graph?.nodes, selected?.changeId],
  );
  const nextHistoryRevset = useMemo(
    () => (graph?.supported && !hasCustomRevset ? resolveNextHistoryRevset(graph.nodes) : null),
    [graph?.nodes, graph?.supported, hasCustomRevset],
  );
  const selectedHistoryRevset = useMemo(
    () =>
      graph?.supported && !hasCustomRevset && selected
        ? resolveMissingParentHistoryRevset({
            nodes: graph.nodes,
            changeIds: [selected.changeId],
          })
        : null,
    [graph?.nodes, graph?.supported, hasCustomRevset, selected],
  );
  const loadMoreGraphHistory = useCallback(
    (revset: string | null = nextHistoryRevset) => {
      if (
        !environmentId ||
        !cwd ||
        !revset ||
        isLoadingGraphHistory ||
        requestedHistoryRevsetsRef.current.has(revset)
      ) {
        return;
      }
      requestedHistoryRevsetsRef.current.add(revset);
      setIsLoadingGraphHistory(true);
      void queryClient
        .fetchQuery(
          gitCommitGraphQueryOptions({
            environmentId,
            cwd,
            revset,
            limit: GRAPH_LAZY_LOAD_BATCH_SIZE,
            threadId: threadId ?? null,
            turnId: focusTurnId ?? null,
          }),
        )
        .then((page) => {
          setGraphHistoryPages((existing) => [...existing, page]);
        })
        .catch((error: unknown) => {
          requestedHistoryRevsetsRef.current.delete(revset);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not extend JJ graph",
              description:
                error instanceof Error ? error.message : "Older JJ history could not be loaded.",
            }),
          );
        })
        .finally(() => setIsLoadingGraphHistory(false));
    },
    [
      cwd,
      environmentId,
      focusTurnId,
      isLoadingGraphHistory,
      nextHistoryRevset,
      queryClient,
      threadId,
    ],
  );
  const maybeLoadMoreGraphHistory = useCallback(
    (viewport: GraphViewport | null = graphViewportRef.current) => {
      if (!viewport || !nextHistoryRevset) return;
      const graphCanvas = graphKeyboardRef.current;
      if (!graphCanvas || flowGraph.nodes.length === 0) return;
      const visibleRevset = resolveViewportHistoryRevset({
        flowNodes: flowGraph.nodes,
        viewport,
        viewportElement: graphCanvas,
      });
      if (visibleRevset) {
        loadMoreGraphHistory(visibleRevset);
        return;
      }
      const visibleBottom = (graphCanvas.clientHeight - viewport.y) / viewport.zoom;
      const loadedBottom = Math.max(
        ...flowGraph.nodes.map((node) => node.position.y + GRAPH_NODE_HEIGHT),
      );
      if (loadedBottom - visibleBottom < GRAPH_LAZY_LOAD_THRESHOLD_PX) {
        loadMoreGraphHistory(nextHistoryRevset);
      }
    },
    [flowGraph.nodes, loadMoreGraphHistory, nextHistoryRevset],
  );
  useEffect(() => {
    maybeLoadMoreGraphHistory();
  }, [flowGraph.nodes.length, maybeLoadMoreGraphHistory]);
  useEffect(() => {
    if (selectedHistoryRevset) {
      loadMoreGraphHistory(selectedHistoryRevset);
    }
  }, [loadMoreGraphHistory, selectedHistoryRevset]);
  const defaultSelectedChangeId =
    initialChangeId ??
    [...focusedChangeIds][0] ??
    graph?.nodes.find((node) => node.currentWorkingCopy)?.changeId ??
    graph?.nodes[0]?.changeId;
  const visualSelectedChangeId = selected?.changeId ?? defaultSelectedChangeId;
  useEffect(() => {
    const layoutSignature = flowGraph.nodes
      .map((node) => `${node.id}:${node.position.x},${node.position.y}`)
      .join("|");
    const layoutChanged = graphLayoutSignatureRef.current !== layoutSignature;
    const shouldAnimateLayout =
      hasRenderedGraphLayoutRef.current && flowGraph.nodes.length > 0 && layoutChanged;
    if (graphLayoutTransitionTimeoutRef.current) {
      clearTimeout(graphLayoutTransitionTimeoutRef.current);
      graphLayoutTransitionTimeoutRef.current = null;
    }
    if (shouldAnimateLayout) {
      setAnimateGraphLayout(true);
      graphLayoutTransitionTimeoutRef.current = setTimeout(() => {
        setAnimateGraphLayout(false);
        graphLayoutTransitionTimeoutRef.current = null;
      }, GRAPH_LAYOUT_TRANSITION_MS + 80);
    } else {
      setAnimateGraphLayout(false);
    }
    setFlowNodes(
      flowGraph.nodes.map((node) => ({
        ...node,
        selected: node.id === visualSelectedChangeId,
      })),
    );
    if (flowGraph.nodes.length > 0) {
      hasRenderedGraphLayoutRef.current = true;
    }
    graphLayoutSignatureRef.current = layoutSignature;
  }, [flowGraph.nodes, setFlowNodes, visualSelectedChangeId]);
  useEffect(
    () => () => {
      if (graphLayoutTransitionTimeoutRef.current) {
        clearTimeout(graphLayoutTransitionTimeoutRef.current);
      }
    },
    [],
  );
  const focusGraphKeyboard = useCallback(() => {
    graphKeyboardRef.current?.focus({ preventScroll: true });
  }, []);
  const selectGraphNode = useCallback(
    (changeId: string, options?: { syncFlowSelection?: boolean }) => {
      focusGraphKeyboard();
      const alreadySelected = selectedChangeIdRef.current === changeId;
      if (!alreadySelected) {
        selectedChangeIdRef.current = changeId;
        startTransition(() => {
          setSelectedChangeId(changeId);
        });
      }
      if (options?.syncFlowSelection && !alreadySelected) {
        setFlowNodes((nodes) =>
          nodes.map((node) => {
            const selectedNode = node.id === changeId;
            return node.selected === selectedNode ? node : { ...node, selected: selectedNode };
          }),
        );
      }
    },
    [focusGraphKeyboard, setFlowNodes],
  );
  const handleNodeClick = useCallback(
    (_: unknown, node: Node<GraphNodeData>) => {
      selectGraphNode(node.id);
    },
    [selectGraphNode],
  );
  const applyRevsetInput = useCallback(() => {
    const nextRevset = revsetInput.trim() || null;
    setAppliedRevset(nextRevset);
    setRevsetInput(nextRevset ?? "");
  }, [revsetInput]);
  const runAction = useCallback(
    (action: GitCommitGraphAction) => {
      if (!graph?.currentOperationId) return;
      setDialogKind(null);
      actionMutation.mutate(
        { expectedOperationId: graph.currentOperationId, action },
        {
          onSuccess: () => {
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "JJ action applied",
                description: "The graph and repository status were refreshed.",
              }),
            );
          },
          onError: (error) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "JJ graph action failed",
                description: error instanceof Error ? error.message : "An unknown error occurred.",
              }),
            );
          },
        },
      );
    },
    [actionMutation, graph?.currentOperationId],
  );
  const runGraphCommand = useCallback(
    (command: GraphCommand, target = selectedRef.current) => {
      if (!target || actionMutation.isPending) return;

      selectGraphNode(target.changeId);

      if (command === "edit") {
        runAction({ kind: "edit", changeId: target.changeId });
        return;
      }
      if (command === "copy_change_id") {
        copyToClipboard(target.changeId, "Change ID");
        return;
      }
      if (command === "copy_commit_id") {
        copyToClipboard(target.commitId, "Commit ID");
        return;
      }
      if (isDialogCommand(command)) {
        setDialogKind(command);
      }
    },
    [actionMutation.isPending, copyToClipboard, runAction, selectGraphNode],
  );
  const handleGraphKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (dialogKind !== null || isTextEntryTarget(event.target)) return;
      const command = commandForGraphKey(event);
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      runGraphCommand(command);
    },
    [dialogKind, runGraphCommand],
  );
  const handleNodeDoubleClick = useCallback(
    (event: ReactMouseEvent, node: Node<GraphNodeData>) => {
      event.preventDefault();
      runGraphCommand("edit", node.data.node);
    },
    [runGraphCommand],
  );
  const handleNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: Node<GraphNodeData>) => {
      event.preventDefault();
      event.stopPropagation();
      const menuPosition = { x: event.clientX, y: event.clientY };
      selectGraphNode(node.id);

      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const clicked = await api.contextMenu.show(GRAPH_CONTEXT_MENU_ITEMS, menuPosition);
        if (!clicked || !isGraphCommand(clicked)) return;
        runGraphCommand(clicked, node.data.node);
      })();
    },
    [runGraphCommand, selectGraphNode],
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(REVIEW_SPLIT_STORAGE_KEY, String(graphReviewSplit));
    } catch {
      // Ignore restricted storage contexts; the split remains usable for this session.
    }
  }, [graphReviewSplit]);
  useEffect(
    () => () => {
      graphReviewDragAbortRef.current?.abort();
    },
    [],
  );
  const handleGraphReviewSplitterPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = graphReviewContainerRef.current;
      if (!container) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      graphReviewDragAbortRef.current?.abort();
      const abortController = new AbortController();
      graphReviewDragAbortRef.current = abortController;

      const updateSplit = (clientY: number) => {
        const rect = container.getBoundingClientRect();
        if (rect.height <= 0) return;
        const nextSplit = ((clientY - rect.top) / rect.height) * 100;
        setGraphReviewSplit(clampGraphReviewSplit(nextSplit));
      };
      const handlePointerMove = (moveEvent: PointerEvent) => updateSplit(moveEvent.clientY);
      const handlePointerUp = () => {
        abortController.abort();
        if (graphReviewDragAbortRef.current === abortController) {
          graphReviewDragAbortRef.current = null;
        }
      };

      updateSplit(event.clientY);
      window.addEventListener("pointermove", handlePointerMove, { signal: abortController.signal });
      window.addEventListener("pointerup", handlePointerUp, {
        once: true,
        signal: abortController.signal,
      });
    },
    [],
  );
  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-background", mode === "sheet" ? "w-full" : "")}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <GitForkIcon className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="shrink-0 font-semibold text-sm">JJ graph</h2>
          <span className="min-w-0 truncate text-muted-foreground text-xs" title={cwd ?? cwdLabel}>
            {cwdLabel}
          </span>
          {graph ? (
            <>
              <span className="hidden text-muted-foreground/70 text-xs sm:inline">·</span>
              <span className="shrink-0 font-medium text-xs" title={graph.revset}>
                {graph.nodes.length} changes
              </span>
              {isLoadingGraphHistory ? (
                <span className="rounded-md border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">
                  Loading history
                </span>
              ) : nextHistoryRevset ? (
                <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 text-xs dark:text-amber-300">
                  More history
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center rounded-md bg-muted/50 p-0.5">
          {JJ_GRAPH_REVSET_PRESETS.map(({ label, revset }) => (
            <Button
              key={label}
              size="xs"
              variant={appliedRevset === revset ? "secondary" : "ghost"}
              className="h-6"
              onClick={() => {
                setRevsetInput(revset ?? "");
                setAppliedRevset(revset);
                setShowRevsetEditor(false);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <Button
          size="xs"
          variant={showCustomRevsetRow ? "secondary" : "ghost"}
          onClick={() => setShowRevsetEditor((value) => !value)}
        >
          {hasCustomRevset ? "Custom" : "Revset"}
        </Button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={showMiniMap ? "Hide minimap" : "Show minimap"}
            title={showMiniMap ? "Hide minimap" : "Show minimap"}
            size="icon-xs"
            variant={showMiniMap ? "secondary" : "ghost"}
            onClick={() => setShowMiniMap((value) => !value)}
          >
            <MapIcon />
          </Button>
        </div>
        <Button
          aria-label="Refresh JJ graph"
          title="Refresh JJ graph"
          size="icon-xs"
          variant="outline"
          onClick={() => {
            setGraphHistoryPages([]);
            requestedHistoryRevsetsRef.current.clear();
            graphQuery.refetch();
          }}
        >
          <RefreshCwIcon className={cn(graphQuery.isFetching && "animate-spin")} />
        </Button>
        <Button
          aria-label="Close JJ graph"
          title="Close JJ graph"
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {showCustomRevsetRow ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <Input
            value={revsetInput}
            onChange={(event) => setRevsetInput(event.target.value)}
            placeholder="Custom JJ revset"
            className="h-7 min-w-48 flex-1 text-sm"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                applyRevsetInput();
              } else if (event.key === "Escape" && !hasCustomRevset) {
                setShowRevsetEditor(false);
              }
            }}
          />
          <Button size="xs" variant="outline" onClick={applyRevsetInput}>
            Apply
          </Button>
          {!hasCustomRevset ? (
            <Button size="xs" variant="ghost" onClick={() => setShowRevsetEditor(false)}>
              Hide
            </Button>
          ) : null}
        </div>
      ) : null}
      {graphQuery.isPending ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
          <Loader2Icon className="mr-2 size-4 animate-spin" />
          Loading JJ graph...
        </div>
      ) : graphQuery.isError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm">
          <div>
            <p className="font-medium text-destructive">JJ graph unavailable</p>
            <p className="mt-1 text-muted-foreground">
              {graphQuery.error instanceof Error
                ? graphQuery.error.message
                : "Could not load the graph."}
            </p>
          </div>
        </div>
      ) : graph && !graph.supported ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Commit graph actions are available for JJ repositories.
        </div>
      ) : (
        <div ref={graphReviewContainerRef} className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex min-h-36 min-w-0 flex-none flex-col"
            style={{ flexBasis: `${graphReviewSplit}%` }}
          >
            <div
              ref={graphKeyboardRef}
              className={cn(
                "jj-commit-graph-canvas min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                animateGraphLayout && "jj-commit-graph-canvas-animating",
              )}
              tabIndex={0}
              onKeyDown={handleGraphKeyDown}
            >
              <ReactFlow
                key={graph?.revset ?? appliedRevset ?? "jj-graph"}
                nodes={flowNodes}
                edges={flowGraph.edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onFlowNodesChange}
                defaultViewport={{ x: 8, y: 24, zoom: 1 }}
                onNodeClick={handleNodeClick}
                onNodeDoubleClick={handleNodeDoubleClick}
                onNodeContextMenu={handleNodeContextMenu}
                onMove={(_, viewport) => {
                  graphViewportRef.current = viewport;
                  maybeLoadMoreGraphHistory(viewport);
                }}
                onMoveEnd={(_, viewport) => {
                  graphViewportRef.current = viewport;
                  maybeLoadMoreGraphHistory(viewport);
                }}
                minZoom={0.25}
                maxZoom={1.5}
                onlyRenderVisibleElements
                zoomOnScroll={false}
                zoomOnPinch
                panOnScroll
                panOnScrollMode={PanOnScrollMode.Free}
                panOnScrollSpeed={1}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={false}
                edgesFocusable={false}
                edgesReconnectable={false}
                connectOnClick={false}
                selectNodesOnDrag={false}
                zoomOnDoubleClick={false}
                proOptions={{ hideAttribution: true }}
              >
                <Controls position="bottom-left" />
                {showMiniMap ? (
                  <MiniMap
                    pannable
                    zoomable
                    position="top-right"
                    style={{ width: 110, height: 82 }}
                    nodeColor={(node) =>
                      (node.data as GraphNodeData).node.currentWorkingCopy
                        ? "var(--primary)"
                        : "var(--muted-foreground)"
                    }
                  />
                ) : null}
              </ReactFlow>
            </div>
          </div>
          <div
            aria-label="Resize graph and review panes"
            aria-orientation="horizontal"
            aria-valuemax={MAX_GRAPH_REVIEW_SPLIT}
            aria-valuemin={MIN_GRAPH_REVIEW_SPLIT}
            aria-valuenow={Math.round(graphReviewSplit)}
            className="group relative z-10 flex h-3 shrink-0 cursor-row-resize items-center justify-center bg-background"
            role="separator"
            tabIndex={0}
            onDoubleClick={() => setGraphReviewSplit(DEFAULT_GRAPH_REVIEW_SPLIT)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setGraphReviewSplit((value) => clampGraphReviewSplit(value - 4));
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setGraphReviewSplit((value) => clampGraphReviewSplit(value + 4));
              } else if (event.key === "Home") {
                event.preventDefault();
                setGraphReviewSplit(MIN_GRAPH_REVIEW_SPLIT);
              } else if (event.key === "End") {
                event.preventDefault();
                setGraphReviewSplit(MAX_GRAPH_REVIEW_SPLIT);
              }
            }}
            onPointerDown={handleGraphReviewSplitterPointerDown}
          >
            <div className="h-px w-full bg-border transition-colors group-hover:bg-primary/40 group-focus-visible:bg-primary/60" />
          </div>
          <JjCommitGraphInspector
            selected={selected}
            environmentId={environmentId}
            cwd={cwd}
            mode={mode}
          />
        </div>
      )}
      <JjCommitGraphActionDialog
        kind={dialogKind}
        selected={selected}
        pending={actionMutation.isPending}
        onClose={() => setDialogKind(null)}
        onSubmit={runAction}
      />
    </div>
  );
}
