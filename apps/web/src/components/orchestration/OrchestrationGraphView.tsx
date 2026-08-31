/**
 * The provenance graph: who launched whom, which threads a batch owns, and the
 * messages that crossed between them.
 *
 * Edges are drawn in SVG and nodes are real HTML buttons positioned over it.
 * `foreignObject` would put the whole card inside the SVG, where text
 * truncation, focus rings and hit targets all behave differently from the rest
 * of the app — and a graph a keyboard cannot reach is a picture, not a view.
 *
 * The layout is deterministic (see `graphLayout.ts`), so nothing here animates
 * and nothing re-settles: selecting a node repaints one ring, not the canvas.
 */
import { XIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import {
  layoutOrchestrationGraph,
  GRAPH_GROUP_HEADER,
  GRAPH_GROUP_PADDING,
} from "../../orchestration/graphLayout";
import { buildOrchestrationGraphModel } from "../../orchestration/graphModel";
import type { GraphNodeDescriptor } from "../../orchestration/graphModel";
import { findWorker, formatDuration } from "../../orchestration/model";
import type { BatchView, OrchestrationSnapshotWire } from "../../orchestration/model";
import {
  BATCH_PHASE_PRESENTATION,
  WORKER_STATE_PRESENTATION,
  toneTextClass,
} from "../../orchestration/presentation";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { StateDot, ToneBadge } from "./OrchestrationStateBadge";

const COORDINATOR_PRESENTATION = { label: "Coordinator", tone: "neutral" } as const;

function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground text-xs">
      <span className="inline-flex items-center gap-2">
        <svg aria-hidden className="h-2 w-8 overflow-visible" viewBox="0 0 32 8">
          <line className="stroke-border" strokeWidth={1.5} x1={0} x2={32} y1={4} y2={4} />
        </svg>
        Created it
      </span>
      <span className="inline-flex items-center gap-2">
        <svg aria-hidden className="h-2 w-8 overflow-visible" viewBox="0 0 32 8">
          <line
            className="stroke-muted-foreground/50"
            strokeDasharray="3 3"
            strokeWidth={1.5}
            x1={0}
            x2={32}
            y1={4}
            y2={4}
          />
        </svg>
        Messaged or read it
      </span>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="size-3 rounded-[3px] border border-dashed border-border" />
        One batch
      </span>
    </div>
  );
}

function GraphNodeCard({
  descriptor,
  selected,
  onSelect,
}: {
  readonly descriptor: GraphNodeDescriptor;
  readonly selected: boolean;
  readonly onSelect: (nodeId: string) => void;
}) {
  const presentation = descriptor.state
    ? WORKER_STATE_PRESENTATION[descriptor.state]
    : COORDINATOR_PRESENTATION;
  const meta = [descriptor.role, descriptor.modelLabel].filter(Boolean).join(" · ");
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex size-full cursor-pointer flex-col justify-center gap-1 overflow-hidden rounded-lg border bg-card px-2.5 py-2 text-start shadow-xs/5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent/50",
        selected && "border-primary ring-2 ring-primary/40",
      )}
      onClick={() => onSelect(descriptor.id)}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StateDot presentation={presentation} />
        <span className="min-w-0 truncate font-medium text-foreground text-xs">
          {descriptor.title}
        </span>
      </span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
        {meta || presentation.label}
      </span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
        {descriptor.hostLabel}
        {descriptor.workspaceLabel && !descriptor.isolated ? " · shared checkout" : ""}
      </span>
    </button>
  );
}

/**
 * What a selected node actually is. A node can be a worker, a coordinator, or
 * both, so the panel answers all three questions rather than assuming the
 * common case and going blank on the nested batch.
 */
function GraphSelectionDetail({
  descriptor,
  batches,
  coordinatedBatches,
  onCompare,
  onClear,
}: {
  readonly descriptor: GraphNodeDescriptor;
  readonly batches: readonly BatchView[];
  readonly coordinatedBatches: readonly BatchView[];
  readonly onCompare: (batchId: string) => void;
  readonly onClear: () => void;
}) {
  const found = findWorker(batches, descriptor.id);
  const presentation = found
    ? WORKER_STATE_PRESENTATION[found.worker.state]
    : COORDINATOR_PRESENTATION;
  const duration = found ? formatDuration(found.worker.durationMs) : null;

  return (
    <Card className="min-w-0 gap-3 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="min-w-0 text-pretty font-semibold text-foreground text-sm">
            {descriptor.title}
          </span>
          <span className="text-muted-foreground text-xs">
            {[descriptor.role, descriptor.modelLabel, descriptor.hostLabel, duration]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <ToneBadge className="shrink-0" presentation={presentation} />
        <Button aria-label="Clear selection" onClick={onClear} size="icon-xs" variant="ghost">
          <XIcon />
        </Button>
      </div>

      {found?.worker.reason ? (
        <p className={cn("text-xs", toneTextClass(presentation.tone))}>{found.worker.reason}</p>
      ) : null}
      {found?.worker.summary ? (
        <p className="text-muted-foreground text-xs">{found.worker.summary}</p>
      ) : null}

      {found ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
          <span className="truncate">In {found.batch.title}</span>
          <span>·</span>
          <span className="truncate">{found.batch.barrierLabel}</span>
        </div>
      ) : null}

      {coordinatedBatches.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2 border-t pt-3">
          <span className="text-muted-foreground text-xs">
            Coordinates {coordinatedBatches.length}{" "}
            {coordinatedBatches.length === 1 ? "batch" : "batches"}
          </span>
          {coordinatedBatches.map((batch) => (
            <div key={batch.batchId} className="flex min-w-0 items-center gap-2">
              <ToneBadge presentation={BATCH_PHASE_PRESENTATION[batch.phase]} />
              <span className="min-w-0 flex-1 truncate text-foreground text-xs">{batch.title}</span>
              <Button
                disabled={batch.tally.outstanding > 0 || batch.workers.length < 2}
                onClick={() => onCompare(batch.batchId)}
                size="micro"
                variant="outline"
              >
                Compare
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export function OrchestrationGraphView({
  snapshot,
  batches,
  selectedNodeId,
  onSelectNode,
  onCompare,
}: {
  readonly snapshot: OrchestrationSnapshotWire;
  readonly batches: readonly BatchView[];
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string | null) => void;
  readonly onCompare: (batchId: string) => void;
}) {
  const model = useMemo(() => buildOrchestrationGraphModel(snapshot), [snapshot]);
  const layout = useMemo(
    () => layoutOrchestrationGraph({ nodes: model.nodes, edges: model.edges }),
    [model],
  );
  const batchesById = useMemo(
    () => new Map(batches.map((batch) => [batch.batchId, batch] as const)),
    [batches],
  );

  const selectedDescriptor = selectedNodeId
    ? (model.descriptorsById.get(selectedNodeId) ?? null)
    : null;
  const coordinatedBatches = useMemo(() => {
    if (!selectedNodeId) {
      return [];
    }
    return [...model.coordinatorByBatchId.entries()]
      .filter(([, coordinatorId]) => coordinatorId === selectedNodeId)
      .map(([batchId]) => batchesById.get(batchId))
      .filter((batch): batch is BatchView => batch !== undefined);
  }, [batchesById, model.coordinatorByBatchId, selectedNodeId]);

  if (layout.nodes.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GraphLegend />
      {/* The canvas scrolls rather than scaling: a graph shrunk to fit a phone
          is unreadable, and a readable graph you have to pan is not. */}
      <div className="min-w-0 overflow-auto rounded-xl border bg-muted/24 p-2">
        <div
          className="relative"
          style={{ height: `${layout.height}px`, width: `${layout.width}px` }}
        >
          <svg aria-hidden className="absolute inset-0" height={layout.height} width={layout.width}>
            <defs>
              <marker
                id="orchestration-graph-arrow"
                markerHeight={6}
                markerWidth={6}
                orient="auto"
                refX={5}
                refY={3}
              >
                <path className="fill-border" d="M0 0 L6 3 L0 6 Z" />
              </marker>
            </defs>
            {layout.groups.map((group) => {
              const batch = batchesById.get(group.batchId);
              return (
                <g key={group.batchId}>
                  <rect
                    className="fill-background/40 stroke-border"
                    height={group.height}
                    rx={12}
                    strokeDasharray="4 4"
                    width={group.width}
                    x={group.x}
                    y={group.y}
                  />
                  <text
                    className="fill-muted-foreground text-[11px]"
                    x={group.x + GRAPH_GROUP_PADDING}
                    y={group.y + GRAPH_GROUP_HEADER - 4}
                  >
                    {batch ? `${batch.title} · ${batch.shortId}` : group.batchId}
                  </text>
                </g>
              );
            })}
            {layout.edges.map((edge) => (
              <path
                key={edge.id}
                className={cn(
                  "fill-none",
                  edge.structural ? "stroke-border" : "stroke-muted-foreground/50",
                )}
                d={edge.path}
                markerEnd={edge.structural ? "url(#orchestration-graph-arrow)" : undefined}
                strokeDasharray={edge.structural ? undefined : "4 4"}
                strokeWidth={1.5}
              />
            ))}
          </svg>
          {layout.nodes.map((node) => {
            const descriptor = model.descriptorsById.get(node.id);
            if (!descriptor) {
              return null;
            }
            return (
              <div
                key={node.id}
                className="absolute"
                style={{
                  height: `${node.height}px`,
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: `${node.width}px`,
                }}
              >
                <GraphNodeCard
                  descriptor={descriptor}
                  onSelect={(nodeId) => onSelectNode(selectedNodeId === nodeId ? null : nodeId)}
                  selected={selectedNodeId === node.id}
                />
              </div>
            );
          })}
        </div>
      </div>
      {selectedDescriptor ? (
        <GraphSelectionDetail
          batches={batches}
          coordinatedBatches={coordinatedBatches}
          descriptor={selectedDescriptor}
          onClear={() => onSelectNode(null)}
          onCompare={onCompare}
        />
      ) : null}
    </div>
  );
}
