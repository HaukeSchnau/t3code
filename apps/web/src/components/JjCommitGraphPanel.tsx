import type {
  ContextMenuItem,
  EnvironmentId,
  GitCommitGraphAction,
  GitCommitGraphNode as GitCommitGraphNodeContract,
} from "@t3tools/contracts";
import {
  BaseEdge,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  useNodesState,
  Position,
  Handle,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitForkIcon,
  Loader2Icon,
  RefreshCwIcon,
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
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  gitCommitGraphActionMutationOptions,
  gitCommitGraphDetailsQueryOptions,
  gitCommitGraphQueryOptions,
  GIT_COMMIT_GRAPH_DEFAULT_LIMIT,
} from "~/lib/gitReactQuery";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
import { Kbd, KbdGroup } from "./ui/kbd";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";

type GraphNodeData = {
  readonly node: GitCommitGraphNodeContract;
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
  mode: "sidebar" | "sheet";
  onClose: () => void;
}

const JJ_GRAPH_CURRENT_LINE_REVSET = "first_ancestors(@, 80) | @";
const JJ_GRAPH_REVSET_PRESETS = [
  { label: "Recent work", revset: null },
  { label: "Current line", revset: JJ_GRAPH_CURRENT_LINE_REVSET },
  { label: "Ancestors", revset: "ancestors(@, 80)" },
] as const;
const GRAPH_COMPONENT_GAP = 180;
const GRAPH_NODE_HEIGHT = 96;
const GRAPH_ROW_GAP = 128;
const GRAPH_NODE_X = 16;
const GRAPH_LANE_GAP = 168;
const GRAPH_RECENT_NODE_COUNT = 10;
const GRAPH_CURRENT_LINE_NODE_COUNT = 6;
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
};

function graphEdgeKey(changeId: string, parentChangeId: string): string {
  return `${changeId}:${parentChangeId}`;
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
  let componentOffsetY = 0;
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

    let maxRow = 0;
    componentNodes.forEach((node) => {
      const lane = laneByChangeId.get(node.changeId) ?? 0;
      const row = rowByChangeId.get(node.changeId) ?? 0;
      maxRow = Math.max(maxRow, row);
      positions.set(node.changeId, {
        x: GRAPH_NODE_X + lane * GRAPH_LANE_GAP,
        y: componentOffsetY + row * GRAPH_ROW_GAP,
      });
    });

    componentOffsetY += (maxRow + 1) * GRAPH_ROW_GAP + GRAPH_COMPONENT_GAP;
  }

  return {
    positions,
    edgeKinds,
    currentLineNodeIds,
    recentNodeIds: nodes.slice(0, GRAPH_RECENT_NODE_COUNT).map((node) => node.changeId),
  };
}

function buildFlowGraph(input: { nodes: readonly GitCommitGraphNodeContract[] }): {
  nodes: Node<GraphNodeData>[];
  edges: Edge[];
  currentLineNodeIds: string[];
  recentNodeIds: string[];
} {
  const { positions, edgeKinds, currentLineNodeIds, recentNodeIds } = buildGraphLayout(input.nodes);
  const nodeIds = new Set(input.nodes.map((node) => node.changeId));
  const flowNodes: Node<GraphNodeData>[] = input.nodes.map((node) => ({
    id: node.changeId,
    type: "jjCommit",
    data: { node },
    position: positions.get(node.changeId) ?? { x: 0, y: 0 },
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  }));
  const flowEdges: Edge[] = input.nodes.flatMap((node) =>
    node.parentChangeIds
      .filter((parentChangeId) => nodeIds.has(parentChangeId))
      .map((parentChangeId) => {
        const edgeKind = edgeKinds.get(graphEdgeKey(node.changeId, parentChangeId)) ?? "branch";
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
          } satisfies GraphEdgeData,
          style: {
            strokeWidth: edgeKind === "spine" ? 2.25 : 1.25,
            opacity: edgeKind === "spine" ? 0.95 : edgeKind === "merge" ? 0.5 : 0.7,
            strokeDasharray: edgeKind === "merge" ? "6 6" : undefined,
          },
        };
      }),
  );
  return { nodes: flowNodes, edges: flowEdges, currentLineNodeIds, recentNodeIds };
}

function JjCommitGraphEdge(props: EdgeProps) {
  const data = props.data as GraphEdgeData | undefined;
  const kind = data?.kind ?? "branch";
  const verticalDistance = Math.max(0, props.targetY - props.sourceY);
  const midY = props.sourceY + Math.max(22, verticalDistance / 2);
  const path = [
    `M ${props.sourceX} ${props.sourceY}`,
    `L ${props.sourceX} ${midY}`,
    `L ${props.targetX} ${midY}`,
    `L ${props.targetX} ${props.targetY}`,
  ].join(" ");

  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={{
        stroke: kind === "spine" ? "var(--primary)" : "var(--muted-foreground)",
        strokeWidth: kind === "spine" ? 2.5 : 1.35,
        opacity: kind === "spine" ? 0.95 : kind === "merge" ? 0.48 : 0.72,
        strokeDasharray: kind === "merge" ? "5 5" : undefined,
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

function ShortcutHint(props: { keys: readonly string[]; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <KbdGroup className="shrink-0">
        {props.keys.map((key) => (
          <Kbd key={key} className={key.length > 1 ? "min-w-fit px-1.5" : undefined}>
            {key}
          </Kbd>
        ))}
      </KbdGroup>
      <span className="min-w-0 truncate">{props.label}</span>
    </div>
  );
}

function JjCommitGraphInspector(props: {
  selected: GitCommitGraphNodeContract | null;
  environmentId: EnvironmentId;
  cwd: string | null;
  mode: "sidebar" | "sheet";
}) {
  const selected = props.selected;
  const detailsQuery = useQuery(
    gitCommitGraphDetailsQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      changeId: selected?.changeId ?? null,
    }),
  );
  const compact = props.mode === "sidebar";
  if (!selected) {
    return (
      <aside
        className={cn(
          "flex min-h-0 w-full shrink-0 flex-col border-t border-border bg-background p-4 text-muted-foreground text-sm",
          props.mode === "sheet" ? "lg:w-80 lg:border-l lg:border-t-0" : "max-h-56",
        )}
      >
        Select a change to inspect JJ metadata and actions.
      </aside>
    );
  }
  const detail = detailsQuery.data;
  return (
    <aside
      className={cn(
        "flex min-h-0 w-full shrink-0 flex-col border-t border-border bg-background",
        props.mode === "sheet" ? "lg:w-88 lg:border-l lg:border-t-0" : "max-h-56",
      )}
    >
      <div className={cn("border-b border-border", compact ? "p-3" : "p-4")}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <GitCommitHorizontalIcon className="size-4" />
          <span>{selected.displayChangeId}</span>
          <span>{selected.shortCommitId}</span>
        </div>
        <h3 className={cn("font-semibold", compact ? "mt-1 text-sm" : "mt-2 text-base")}>
          {selected.description || "(no description set)"}
        </h3>
        <p className="mt-1 text-muted-foreground text-xs">
          {selected.authorName || "Unknown author"} · {selected.committerTimestamp}
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(compact ? "space-y-3 p-3" : "space-y-5 p-4")}>
          <section className="grid gap-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Shortcuts</h4>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
              <ShortcutHint keys={["Enter", "E"]} label="Edit" />
              <ShortcutHint keys={["D"]} label="Describe" />
              <ShortcutHint keys={["N"]} label="New child" />
              <ShortcutHint keys={["A", "B"]} label="Insert" />
              <ShortcutHint keys={["C"]} label="Copy change" />
              <ShortcutHint keys={["Shift", "C"]} label="Copy commit" />
              <ShortcutHint keys={["M"]} label="Bookmark" />
              <ShortcutHint keys={["R"]} label="Rebase" />
              <ShortcutHint keys={["S"]} label="Squash" />
              <ShortcutHint keys={["X"]} label="Split" />
              <ShortcutHint keys={["Del"]} label="Abandon" />
              <ShortcutHint keys={["Right click"]} label="All actions" />
            </div>
          </section>
          <section className="grid gap-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Files</h4>
            {detailsQuery.isPending ? (
              <div className="text-muted-foreground text-sm">Loading details...</div>
            ) : detailsQuery.isError ? (
              <div className="text-destructive text-sm">
                {detailsQuery.error instanceof Error
                  ? detailsQuery.error.message
                  : "JJ graph details unavailable."}
              </div>
            ) : (
              <>
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs">
                  {detail?.changedFilesSummary.trim() || "No file summary."}
                </pre>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs">
                  {detail?.diffStat.trim() || "No diff stat."}
                </pre>
                {detail?.diffPreview.trim() ? (
                  <details className="rounded-md border border-border/70 bg-muted/30 p-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Preview diff
                      {detail.diffPreviewTruncated ? " (truncated)" : ""}
                    </summary>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap">
                      {detail.diffPreview}
                    </pre>
                  </details>
                ) : null}
              </>
            )}
          </section>
        </div>
      </ScrollArea>
    </aside>
  );
}

export default function JjCommitGraphPanel({
  environmentId,
  cwd,
  mode,
  onClose,
}: JjCommitGraphPanelProps) {
  const queryClient = useQueryClient();
  const [revsetInput, setRevsetInput] = useState("");
  const [appliedRevset, setAppliedRevset] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [dialogKind, setDialogKind] = useState<ActionDialogKind | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<Node<GraphNodeData>>([]);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    Node<GraphNodeData>,
    Edge
  > | null>(null);
  const graphKeyboardRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<GitCommitGraphNodeContract | null>(null);
  const selectedChangeIdRef = useRef<string | null>(null);
  const graphQuery = useQuery(
    gitCommitGraphQueryOptions({
      environmentId,
      cwd,
      revset: appliedRevset,
      limit: GIT_COMMIT_GRAPH_DEFAULT_LIMIT,
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
  const graph = graphQuery.data;
  const selected =
    graph?.nodes.find((node) => node.changeId === selectedChangeId) ??
    graph?.nodes.find((node) => node.currentWorkingCopy) ??
    graph?.nodes[0] ??
    null;
  useEffect(() => {
    selectedRef.current = selected;
    selectedChangeIdRef.current = selected?.changeId ?? null;
  }, [selected]);
  const flowGraph = useMemo(() => buildFlowGraph({ nodes: graph?.nodes ?? [] }), [graph?.nodes]);
  const defaultSelectedChangeId =
    graph?.nodes.find((node) => node.currentWorkingCopy)?.changeId ?? graph?.nodes[0]?.changeId;
  useEffect(
    () =>
      setFlowNodes(
        flowGraph.nodes.map((node) => ({
          ...node,
          selected: node.id === defaultSelectedChangeId,
        })),
      ),
    [defaultSelectedChangeId, flowGraph.nodes, setFlowNodes],
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
  const fitCurrentLine = useCallback(() => {
    if (!flowInstance || flowGraph.currentLineNodeIds.length === 0) return;
    void flowInstance.fitView({
      nodes: flowGraph.currentLineNodeIds
        .slice(0, GRAPH_CURRENT_LINE_NODE_COUNT)
        .map((id) => ({ id })),
      padding: 0.25,
      maxZoom: 1.2,
      duration: 180,
    });
  }, [flowGraph.currentLineNodeIds, flowInstance]);
  const fitRecentChanges = useCallback(() => {
    if (!flowInstance || flowGraph.recentNodeIds.length === 0) return;
    void flowInstance.fitView({
      nodes: flowGraph.recentNodeIds.map((id) => ({ id })),
      padding: 0.25,
      maxZoom: 0.95,
      duration: 180,
    });
  }, [flowGraph.recentNodeIds, flowInstance]);
  const runAction = useCallback(
    (action: GitCommitGraphAction) => {
      if (!graph?.currentOperationId) return;
      actionMutation.mutate(
        { expectedOperationId: graph.currentOperationId, action },
        {
          onSuccess: () => {
            setDialogKind(null);
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
  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-background", mode === "sheet" ? "w-full" : "")}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitForkIcon className="size-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm">JJ graph</h2>
          </div>
          <p className="truncate text-muted-foreground text-xs">
            {cwd ?? "No repository selected"}
          </p>
        </div>
        <Button size="xs" variant="outline" onClick={() => graphQuery.refetch()}>
          <RefreshCwIcon className={cn(graphQuery.isFetching && "animate-spin")} />
          Refresh
        </Button>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Input
          value={revsetInput}
          onChange={(event) => setRevsetInput(event.target.value)}
          placeholder="JJ revset"
          className="h-8 text-sm"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              setAppliedRevset(revsetInput.trim() || null);
            }
          }}
        />
        <Button
          size="xs"
          variant="outline"
          onClick={() => setAppliedRevset(revsetInput.trim() || null)}
        >
          Apply
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-1.5">
        {JJ_GRAPH_REVSET_PRESETS.map(({ label, revset }) => (
          <Button
            key={label}
            size="xs"
            variant={appliedRevset === revset ? "secondary" : "ghost"}
            onClick={() => {
              setRevsetInput(revset ?? "");
              setAppliedRevset(revset);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {graph ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-xs">
          <span className="font-medium text-foreground">{graph.nodes.length} changes</span>
          {graph.hasMore ? (
            <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">
              Truncated; narrow the revset for more history
            </span>
          ) : null}
          <span className="ml-auto truncate text-muted-foreground" title={graph.revset}>
            {appliedRevset === null
              ? "Default: visible heads, bookmarks, remotes, @"
              : `Revset: ${graph.revset}`}
          </span>
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
        <div className={cn("flex min-h-0 flex-1 flex-col", mode === "sheet" && "lg:flex-row")}>
          <div className="flex min-h-96 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 py-2 text-muted-foreground text-xs">
              <span className="truncate">
                Recent JJ work in compact lanes. Drag the canvas to follow branches; @ marks the
                current checkout.
              </span>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="xs"
                  variant={showMiniMap ? "secondary" : "ghost"}
                  onClick={() => setShowMiniMap((value) => !value)}
                >
                  Map
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={flowGraph.recentNodeIds.length === 0}
                  onClick={fitRecentChanges}
                >
                  Recent
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={flowGraph.currentLineNodeIds.length === 0}
                  onClick={fitCurrentLine}
                >
                  Current
                </Button>
              </div>
            </div>
            <div
              ref={graphKeyboardRef}
              className="min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
                onInit={setFlowInstance}
                defaultViewport={{ x: 8, y: 24, zoom: 1 }}
                onNodeClick={handleNodeClick}
                onNodeDoubleClick={handleNodeDoubleClick}
                onNodeContextMenu={handleNodeContextMenu}
                minZoom={0.25}
                maxZoom={1.5}
                onlyRenderVisibleElements
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
