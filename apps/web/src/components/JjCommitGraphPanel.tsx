import type {
  EnvironmentId,
  GitCommitGraphAction,
  GitCommitGraphNode as GitCommitGraphNodeContract,
} from "@t3tools/contracts";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  Position,
  Handle,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitForkIcon,
  GitPullRequestIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  ScissorsIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  gitCommitGraphActionMutationOptions,
  gitCommitGraphDetailsQueryOptions,
  gitCommitGraphQueryOptions,
  GIT_COMMIT_GRAPH_DEFAULT_LIMIT,
} from "~/lib/gitReactQuery";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";

type GraphNodeData = {
  readonly node: GitCommitGraphNodeContract;
  readonly selected: boolean;
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

interface JjCommitGraphPanelProps {
  environmentId: EnvironmentId;
  cwd: string | null;
  mode: "sidebar" | "sheet";
  onClose: () => void;
}

const JJ_GRAPH_DEFAULT_REVSET = "first_ancestors(@, 80) | @";
const JJ_GRAPH_VISIBLE_HEADS_REVSET =
  "ancestors(visible_heads() | bookmarks() | tracked_remote_bookmarks() | @, 151)";
const JJ_GRAPH_REVSET_PRESETS = [
  { label: "Current line", revset: JJ_GRAPH_DEFAULT_REVSET },
  { label: "Ancestors", revset: "ancestors(@, 80)" },
  { label: "Visible heads", revset: JJ_GRAPH_VISIBLE_HEADS_REVSET },
] as const;
const GRAPH_NODE_COLUMN_GAP = 280;
const GRAPH_COMPONENT_GAP = 180;
const GRAPH_ROW_GAP = 112;
const GRAPH_FOCUS_NODE_COUNT = 4;
const GRAPH_MAX_RENDERED_BRANCH_LANE = 2;

type GraphEdgeKind = "spine" | "branch" | "merge";

function graphEdgeKey(changeId: string, parentChangeId: string): string {
  return `${changeId}:${parentChangeId}`;
}

function nearestFreeLane(preferredLane: number, usedLanes: ReadonlySet<number>): number {
  if (!usedLanes.has(preferredLane)) return preferredLane;
  if (preferredLane === 0) {
    for (let distance = 1; distance < usedLanes.size + 24; distance++) {
      if (!usedLanes.has(distance)) return distance;
      if (!usedLanes.has(-distance)) return -distance;
    }
  }
  for (let distance = 1; distance < usedLanes.size + 24; distance++) {
    const candidates = [preferredLane + distance, preferredLane - distance].toSorted(
      (left, right) => Math.abs(left) - Math.abs(right),
    );
    for (const candidate of candidates) {
      if (!usedLanes.has(candidate)) return candidate;
    }
  }
  return usedLanes.size + 1;
}

function renderedLane(lane: number): number {
  if (lane === 0) return 0;
  const direction = lane > 0 ? 1 : -1;
  return direction * Math.min(Math.abs(lane), GRAPH_MAX_RENDERED_BRANCH_LANE);
}

function buildGraphLayout(
  nodes: readonly GitCommitGraphNodeContract[],
  focusChangeId: string | null,
): {
  positions: Map<string, { x: number; y: number }>;
  edgeKinds: Map<string, GraphEdgeKind>;
  focusNodeIds: string[];
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
  const focusedChangeId = focusChangeId ?? currentChangeId;
  components.sort((left, right) => {
    const leftFocused = focusedChangeId ? left.includes(focusedChangeId) : false;
    const rightFocused = focusedChangeId ? right.includes(focusedChangeId) : false;
    if (leftFocused !== rightFocused) return leftFocused ? -1 : 1;
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
  let focusNodeIds: string[] = [];
  let componentOffsetY = 0;
  for (const component of components) {
    const componentIds = new Set(component);
    const componentNodes = component
      .map((changeId) => nodesByChangeId.get(changeId)!)
      .toSorted(
        (left, right) => indexByChangeId.get(left.changeId)! - indexByChangeId.get(right.changeId)!,
      );
    const componentHasFocus = focusedChangeId ? componentIds.has(focusedChangeId) : false;
    const spineStartId =
      componentHasFocus && focusedChangeId
        ? focusedChangeId
        : (componentNodes[0]?.changeId ?? null);
    const spineIds: string[] = [];
    const visitedSpineIds = new Set<string>();
    let nextSpineId = spineStartId;
    while (nextSpineId && componentIds.has(nextSpineId) && !visitedSpineIds.has(nextSpineId)) {
      spineIds.push(nextSpineId);
      visitedSpineIds.add(nextSpineId);
      const firstParentChangeId = nodesByChangeId.get(nextSpineId)?.parentChangeIds[0] ?? null;
      nextSpineId =
        firstParentChangeId && componentIds.has(firstParentChangeId) ? firstParentChangeId : null;
    }
    const spineIdSet = new Set(spineIds);
    if (componentHasFocus || focusNodeIds.length === 0) {
      focusNodeIds = spineIds.slice(0, 12);
    }

    const laneByChangeId = new Map<string, number>();
    const usedLanes = new Set<number>();
    for (const spineId of spineIds) {
      laneByChangeId.set(spineId, 0);
      usedLanes.add(0);
    }

    for (const node of componentNodes) {
      const existingLane = laneByChangeId.get(node.changeId);
      const continuingBranchLane = (childrenByParent.get(node.changeId) ?? [])
        .filter(
          (childChangeId) =>
            nodesByChangeId.get(childChangeId)?.parentChangeIds[0] === node.changeId,
        )
        .map((childChangeId) => laneByChangeId.get(childChangeId))
        .filter((lane): lane is number => lane !== undefined);
      const lane =
        existingLane ??
        continuingBranchLane.find((childLane) => childLane !== 0) ??
        nearestFreeLane(1, usedLanes);
      laneByChangeId.set(node.changeId, lane);
      usedLanes.add(lane);
      node.parentChangeIds
        .filter((parentChangeId) => componentIds.has(parentChangeId))
        .forEach((parentChangeId, parentIndex) => {
          const isFirstParent = parentIndex === 0;
          const isSpineEdge =
            isFirstParent && spineIdSet.has(node.changeId) && spineIdSet.has(parentChangeId);
          edgeKinds.set(
            graphEdgeKey(node.changeId, parentChangeId),
            isSpineEdge ? "spine" : isFirstParent ? "branch" : "merge",
          );
          if (laneByChangeId.has(parentChangeId)) return;
          const parentLane = isSpineEdge
            ? 0
            : isFirstParent
              ? lane
              : nearestFreeLane(lane, usedLanes);
          laneByChangeId.set(parentChangeId, parentLane);
          usedLanes.add(parentLane);
        });
    }

    componentNodes.forEach((node, index) => {
      const lane = renderedLane(laneByChangeId.get(node.changeId) ?? 0);
      positions.set(node.changeId, {
        x: lane * GRAPH_NODE_COLUMN_GAP,
        y: componentOffsetY + index * GRAPH_ROW_GAP,
      });
    });

    componentOffsetY += componentNodes.length * GRAPH_ROW_GAP + GRAPH_COMPONENT_GAP;
  }

  return { positions, edgeKinds, focusNodeIds };
}

function buildFlowGraph(input: {
  nodes: readonly GitCommitGraphNodeContract[];
  selectedChangeId: string | null;
}): { nodes: Node<GraphNodeData>[]; edges: Edge[]; focusNodeIds: string[] } {
  const layoutFocusChangeId =
    input.nodes.find((node) => node.currentWorkingCopy)?.changeId ?? input.selectedChangeId;
  const { positions, edgeKinds, focusNodeIds } = buildGraphLayout(input.nodes, layoutFocusChangeId);
  const nodeIds = new Set(input.nodes.map((node) => node.changeId));
  const flowNodes: Node<GraphNodeData>[] = input.nodes.map((node) => ({
    id: node.changeId,
    type: "jjCommit",
    data: { node, selected: node.changeId === input.selectedChangeId },
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
          type: "smoothstep",
          className: cn(
            "jj-commit-graph-edge",
            edgeKind === "merge" && "jj-commit-graph-edge-merge",
          ),
          style: {
            strokeWidth: edgeKind === "spine" ? 2.25 : 1.25,
            opacity: edgeKind === "spine" ? 0.95 : edgeKind === "merge" ? 0.5 : 0.7,
            strokeDasharray: edgeKind === "merge" ? "6 6" : undefined,
          },
        };
      }),
  );
  return { nodes: flowNodes, edges: flowEdges, focusNodeIds };
}

const JjCommitNode = memo(function JjCommitNode({ data }: NodeProps<Node<GraphNodeData>>) {
  const node = data.node;
  const description = node.description || "(no description set)";
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
  return (
    <div
      className={cn(
        "min-w-56 rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-sm transition-colors",
        data.selected ? "border-primary shadow-primary/15" : "border-border/80",
        node.currentWorkingCopy && "ring-2 ring-primary/35",
      )}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="flex items-start gap-2">
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
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{description}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
            <span>{node.displayChangeId}</span>
            <span>{node.shortCommitId}</span>
            {node.empty ? <span className="rounded bg-muted px-1">empty</span> : null}
            {node.conflict ? (
              <span className="rounded bg-destructive/10 px-1 text-destructive">conflict</span>
            ) : null}
            {node.immutable ? <span className="rounded bg-muted px-1">immutable</span> : null}
          </div>
          {bookmarks.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {bookmarks.slice(0, 4).map(({ key, label }) => (
                <span
                  key={key}
                  className="inline-flex max-w-36 items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-[10px]"
                >
                  <GitBranchIcon className="size-3" />
                  <span className="truncate">{label}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
});

const nodeTypes = { jjCommit: JjCommitNode };

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
      return `jj describe -r ${selected.changeId} -m ${shellQuote(form.message ?? "")}`;
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
      return { kind: "describe", changeId: selected.changeId, message: form.message ?? "" };
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

function JjCommitGraphInspector(props: {
  selected: GitCommitGraphNodeContract | null;
  environmentId: EnvironmentId;
  cwd: string | null;
  mode: "sidebar" | "sheet";
  currentOperationId: string | null;
  onActionRequest: (kind: ActionDialogKind) => void;
  onRunAction: (action: GitCommitGraphAction) => void;
  actionPending: boolean;
}) {
  const selected = props.selected;
  const detailsQuery = useQuery(
    gitCommitGraphDetailsQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      changeId: selected?.changeId ?? null,
    }),
  );
  const { copyToClipboard } = useCopyToClipboard();
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
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Navigate</h4>
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={props.actionPending}
                onClick={() => props.onRunAction({ kind: "edit", changeId: selected.changeId })}
              >
                <GitPullRequestIcon />
                Edit
              </Button>
              <Button size="xs" variant="outline" onClick={() => props.onActionRequest("new")}>
                New child
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("insert_after")}
              >
                Insert after
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("insert_before")}
              >
                Insert before
              </Button>
            </div>
          </section>
          <section className="grid gap-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Change</h4>
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" onClick={() => props.onActionRequest("describe")}>
                <PencilIcon />
                Describe
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => copyToClipboard(selected.changeId, undefined)}
              >
                Copy change ID
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => copyToClipboard(selected.commitId, undefined)}
              >
                Copy commit ID
              </Button>
            </div>
          </section>
          <section className="grid gap-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Bookmarks</h4>
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("bookmark_set")}
              >
                Set
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("bookmark_move")}
              >
                Move
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("bookmark_rename")}
              >
                Rename
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("bookmark_delete")}
              >
                Delete
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("bookmark_track")}
              >
                Track
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("bookmark_untrack")}
              >
                Untrack
              </Button>
            </div>
          </section>
          <section className="grid gap-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Rewrite</h4>
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={() => props.onActionRequest("abandon")}
              >
                Abandon
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onActionRequest("duplicate")}
              >
                Duplicate
              </Button>
              <Button size="xs" variant="outline" onClick={() => props.onActionRequest("rebase")}>
                <GitForkIcon />
                Rebase
              </Button>
              <Button size="xs" variant="outline" onClick={() => props.onActionRequest("squash")}>
                Squash
              </Button>
              <Button size="xs" variant="outline" onClick={() => props.onActionRequest("split")}>
                <ScissorsIcon />
                Split
              </Button>
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
  const [revsetInput, setRevsetInput] = useState(JJ_GRAPH_DEFAULT_REVSET);
  const [appliedRevset, setAppliedRevset] = useState<string | null>(JJ_GRAPH_DEFAULT_REVSET);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [dialogKind, setDialogKind] = useState<ActionDialogKind | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    Node<GraphNodeData>,
    Edge
  > | null>(null);
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
  const graph = graphQuery.data;
  const selected =
    graph?.nodes.find((node) => node.changeId === selectedChangeId) ??
    graph?.nodes.find((node) => node.currentWorkingCopy) ??
    graph?.nodes[0] ??
    null;
  const flowGraph = useMemo(
    () =>
      buildFlowGraph({ nodes: graph?.nodes ?? [], selectedChangeId: selected?.changeId ?? null }),
    [graph?.nodes, selected?.changeId],
  );
  const recentNodeIds = useMemo(() => flowGraph.nodes.map((node) => node.id), [flowGraph.nodes]);
  const fitCurrentLine = useCallback(() => {
    if (!flowInstance || flowGraph.focusNodeIds.length === 0) return;
    void flowInstance.fitView({
      nodes: flowGraph.focusNodeIds.slice(0, GRAPH_FOCUS_NODE_COUNT).map((id) => ({ id })),
      padding: 0.25,
      maxZoom: 1.2,
      duration: 180,
    });
  }, [flowGraph.focusNodeIds, flowInstance]);
  const fitRecentChanges = useCallback(() => {
    if (!flowInstance || recentNodeIds.length === 0) return;
    void flowInstance.fitView({
      nodes: recentNodeIds.slice(0, 10).map((id) => ({ id })),
      padding: 0.25,
      maxZoom: 0.95,
      duration: 180,
    });
  }, [flowInstance, recentNodeIds]);
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
              setRevsetInput(revset);
              setAppliedRevset(revset);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {graph ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-muted-foreground text-xs">
          <span>{graph.nodes.length} changes shown</span>
          {graph.hasMore ? (
            <span>More changes available; narrow the revset to inspect them.</span>
          ) : null}
          <span className="ml-auto truncate">Revset: {graph.revset}</span>
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
                Showing the current line first; pan or use Recent for nearby changes.
              </span>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={flowGraph.focusNodeIds.length === 0}
                  onClick={fitCurrentLine}
                >
                  Current
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={recentNodeIds.length === 0}
                  onClick={fitRecentChanges}
                >
                  Recent
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <ReactFlow
                key={graph?.revset ?? appliedRevset ?? "jj-graph"}
                nodes={flowGraph.nodes}
                edges={flowGraph.edges}
                nodeTypes={nodeTypes}
                onInit={setFlowInstance}
                fitView
                fitViewOptions={{
                  ...(flowGraph.focusNodeIds.length > 0
                    ? {
                        nodes: flowGraph.focusNodeIds
                          .slice(0, GRAPH_FOCUS_NODE_COUNT)
                          .map((id) => ({ id })),
                      }
                    : {}),
                  padding: 0.25,
                  maxZoom: 1.2,
                }}
                onNodeClick={(_, node) => setSelectedChangeId(node.id)}
                minZoom={0.25}
                maxZoom={1.5}
                proOptions={{ hideAttribution: true }}
              >
                <Background />
                <Controls position="bottom-left" />
                {mode === "sheet" ? (
                  <MiniMap
                    pannable
                    zoomable
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
            currentOperationId={graph?.currentOperationId ?? null}
            onActionRequest={setDialogKind}
            onRunAction={runAction}
            actionPending={actionMutation.isPending}
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
