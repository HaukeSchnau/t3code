import { isFollowUpClosed } from "@t3tools/client-runtime/state/follow-ups";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FollowUp, FollowUpId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";

import { type ForceLayout, forceLayout } from "~/lib/forceLayout";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildFollowUpGraph, type FollowUpGraph, type FollowUpGraphNode } from "./followUps.logic";

interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 3;
const FIT_PADDING = 80;
const THREAD_HALF = 3.5;
/** Small nodes still take a click anywhere this close to their centre. */
const HIT_RADIUS = 11;

function layoutGraph(graph: FollowUpGraph): ForceLayout {
  return forceLayout({
    nodes: graph.nodes.map((node) => node.key),
    edges: graph.edges.map((edge) => [edge.from, edge.to] as const),
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const LABEL_SCALE = "--follow-up-graph-label-scale";
// Labels keep their screen size as the graph shrinks; zoomed in, they grow with it.
const LABEL_SCALE_CLASS =
  "[transform:scale(var(--follow-up-graph-label-scale,1))] [transform-box:fill-box]";

/** Labels thin out as the graph shrinks, so a zoomed-out graph stays legible. */
function zoomLevel(scale: number): "far" | "mid" | "near" {
  return scale < 0.5 ? "far" : scale < 0.9 ? "mid" : "near";
}

function applyView(svg: SVGSVGElement, scene: SVGGElement, view: View) {
  scene.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  svg.dataset.zoom = zoomLevel(view.scale);
  const labelScale = String(Math.max(1, 1 / view.scale));
  if (svg.style.getPropertyValue(LABEL_SCALE) !== labelScale) {
    svg.style.setProperty(LABEL_SCALE, labelScale);
  }
}

function fitView(svg: SVGSVGElement, bounds: ForceLayout["bounds"]): View | null {
  const { width, height } = svg.getBoundingClientRect();
  if (width === 0 || height === 0) return null;
  const scale = clamp(
    Math.min(
      width / (bounds.maxX - bounds.minX + FIT_PADDING * 2),
      height / (bounds.maxY - bounds.minY + FIT_PADDING * 2),
    ),
    MIN_SCALE,
    1,
  );
  return {
    scale,
    x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
    y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
  };
}

/** Scales by `factor` around a point given in canvas pixels. */
function zoomView(view: View, factor: number, x: number, y: number): View {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const applied = scale / view.scale;
  return { scale, x: x - (x - view.x) * applied, y: y - (y - view.y) * applied };
}

function truncate(text: string, length: number) {
  const trimmed = text.trim();
  return trimmed.length <= length ? trimmed : `${trimmed.slice(0, length - 1).trimEnd()}…`;
}

function followUpRadius(followUp: FollowUp) {
  if (isFollowUpClosed(followUp)) return 4.5;
  if (followUp.status === "picked_up") return 6;
  return followUp.returnedAt === null ? 7.5 : 8.5;
}

function nodeRadius(node: FollowUpGraphNode) {
  return node.kind === "thread" ? THREAD_HALF + 1 : followUpRadius(node.followUp);
}

function FollowUpMark(props: { readonly followUp: FollowUp }) {
  const { followUp } = props;
  const r = followUpRadius(followUp);
  if (followUp.status === "picked_up") {
    return <circle r={r} className="fill-background stroke-primary" strokeWidth={2} />;
  }
  const fill =
    followUp.status === "open"
      ? followUp.returnedAt === null
        ? "fill-primary"
        : "fill-warning"
      : followUp.status === "done"
        ? "fill-success/60"
        : "fill-muted-foreground/45";
  return <circle r={r} className={fill} />;
}

function GraphControl(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function LegendSwatch(props: { readonly className: string; readonly label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("size-2.5 shrink-0", props.className)} />
      {props.label}
    </span>
  );
}

/**
 * Follow-ups and the threads they name, laid out once per change in nodes or edges. Panning and
 * zooming move one transform outside React, so a few hundred nodes never re-render on a drag.
 */
export function FollowUpGraphView(props: {
  readonly stores: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly followUps: ReadonlyArray<FollowUp>;
  }>;
  readonly showClosed: boolean;
  readonly selectedKey: string | null;
  readonly onSelectFollowUp: (id: FollowUpId) => void;
}) {
  const navigate = useNavigate();
  const graph = buildFollowUpGraph(props.stores, props.showClosed);
  const [laidOut, setLaidOut] = useState(() => ({
    shape: graph.shape,
    layout: layoutGraph(graph),
  }));
  if (laidOut.shape !== graph.shape) {
    setLaidOut({ shape: graph.shape, layout: layoutGraph(graph) });
  }
  const { layout } = laidOut;
  const threadShells = useQuietThreadShells();
  const threadTitles = new Map(
    threadShells.map((shell) => [`thread:${shell.environmentId}:${shell.id}`, shell.title]),
  );
  const markerId = `follow-up-graph-arrow-${useId().replace(/[^\w-]/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const sceneRef = useRef<SVGGElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  // The view refits to the canvas until the user pans or zooms it.
  const followsSizeRef = useRef(true);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly view: View;
    moved: boolean;
  } | null>(null);
  const draggedRef = useRef(false);

  const setView = (view: View, byUser: boolean) => {
    const svg = svgRef.current;
    const scene = sceneRef.current;
    if (!svg || !scene) return;
    viewRef.current = view;
    if (byUser) followsSizeRef.current = false;
    applyView(svg, scene, view);
  };
  const fit = () => {
    const svg = svgRef.current;
    const view = svg ? fitView(svg, layout.bounds) : null;
    if (view === null) return;
    setView(view, false);
    followsSizeRef.current = true;
  };
  const zoomBy = (factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    setView(zoomView(viewRef.current, factor, width / 2, height / 2), true);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fits each new layout to the measured canvas before paint, refits on resize, and takes wheel input, which React only offers as passive
  useLayoutEffect(() => {
    const svg = svgRef.current;
    const scene = sceneRef.current;
    if (!svg || !scene) return;
    const refit = () => {
      const view = fitView(svg, layout.bounds);
      if (view === null) return;
      viewRef.current = view;
      followsSizeRef.current = true;
      applyView(svg, scene, view);
    };
    refit();
    const stopObserving = observeResize(svg, () => {
      if (followsSizeRef.current) refit();
    });
    // Trackpad pinch arrives as a ctrlKey wheel; plain wheels and two-finger swipes pan.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? svg.clientHeight : 1;
      const view = viewRef.current;
      const next =
        event.ctrlKey || event.metaKey
          ? zoomView(
              view,
              Math.exp(-event.deltaY * unit * 0.01),
              event.clientX - svg.getBoundingClientRect().left,
              event.clientY - svg.getBoundingClientRect().top,
            )
          : { ...view, x: view.x - event.deltaX * unit, y: view.y - event.deltaY * unit };
      viewRef.current = next;
      followsSizeRef.current = false;
      applyView(svg, scene, next);
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => {
      stopObserving();
      svg.removeEventListener("wheel", wheel);
    };
  }, [layout]);

  const open = (node: FollowUpGraphNode) => {
    if (node.kind === "followUp") {
      props.onSelectFollowUp(node.followUp.id);
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(node.thread.environmentId, node.thread.threadId),
      ),
    });
  };
  const positionOf = (key: string) => layout.positions.get(key) ?? { x: 0, y: 0 };
  const nodeByKey = new Map(graph.nodes.map((node) => [node.key, node]));

  return (
    <div className="relative size-full min-h-0">
      <svg
        ref={svgRef}
        role="group"
        aria-label="Follow-up graph"
        aria-description="Drag or scroll to pan. Pinch or Ctrl+scroll to zoom. Plus, minus and 0 zoom from the keyboard."
        tabIndex={0}
        data-zoom="near"
        className="group/graph block size-full cursor-grab touch-none outline-none select-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "+" || event.key === "=") zoomBy(1.4);
          else if (event.key === "-") zoomBy(1 / 1.4);
          else if (event.key === "0") fit();
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          draggedRef.current = false;
          if (event.button !== 0 || dragRef.current) return;
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            view: viewRef.current,
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (!drag.moved) {
            if (Math.hypot(dx, dy) < 4) return;
            // Capturing only once the drag starts leaves a plain click on its node.
            drag.moved = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy }, true);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          draggedRef.current = dragRef.current.moved;
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,1 L10,5 L0,9 z" className="fill-muted-foreground/70" />
          </marker>
        </defs>
        <g ref={sceneRef}>
          {graph.edges.map((edge) => {
            const from = positionOf(edge.from);
            const to = positionOf(edge.to);
            const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
            const unitX = (to.x - from.x) / length;
            const unitY = (to.y - from.y) / length;
            const target = nodeByKey.get(edge.to);
            const source = nodeByKey.get(edge.from);
            const start = source ? nodeRadius(source) : 0;
            const end = (target ? nodeRadius(target) : 0) + 2;
            const touchesSelection =
              edge.from === props.selectedKey || edge.to === props.selectedKey;
            // Most follow-ups came from a thread; that label shows only around the selection.
            const labelVisibility = touchesSelection
              ? "group-data-[zoom=far]/graph:hidden"
              : edge.labels.length === 1 && edge.labels[0] === "came from"
                ? "hidden"
                : "hidden group-data-[zoom=near]/graph:inline";
            return (
              <g key={edge.key}>
                <line
                  x1={from.x + unitX * start}
                  y1={from.y + unitY * start}
                  x2={to.x - unitX * end}
                  y2={to.y - unitY * end}
                  // Only links between follow-ups need a direction; a thread is always the target.
                  markerEnd={target?.kind === "followUp" ? `url(#${markerId})` : undefined}
                  strokeWidth={touchesSelection ? 1.75 : 1.25}
                  className={
                    touchesSelection ? "stroke-foreground/60" : "stroke-muted-foreground/35"
                  }
                />
                <text
                  x={(from.x + to.x) / 2}
                  y={(from.y + to.y) / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  strokeWidth={3}
                  className={cn(
                    LABEL_SCALE_CLASS,
                    "pointer-events-none origin-center fill-muted-foreground stroke-background text-3xs [paint-order:stroke]",
                    labelVisibility,
                  )}
                >
                  {edge.labels.join(", ")}
                </text>
              </g>
            );
          })}
          {graph.nodes.map((node) => {
            const point = positionOf(node.key);
            const radius = nodeRadius(node);
            const selected = node.key === props.selectedKey;
            const label =
              node.kind === "followUp"
                ? truncate(node.followUp.title, 32)
                : truncate(threadTitles.get(node.key) || node.recordedTitle || "thread", 24);
            // Pointing at or focusing a node shows its label at any zoom.
            const labelVisibility = selected
              ? undefined
              : node.kind === "thread" || isFollowUpClosed(node.followUp)
                ? "hidden group-hover/node:inline group-focus-visible/node:inline group-data-[zoom=near]/graph:inline"
                : "group-data-[zoom=far]/graph:hidden group-data-[zoom=far]/graph:group-hover/node:inline group-data-[zoom=far]/graph:group-focus-visible/node:inline";
            return (
              <g
                key={node.key}
                transform={`translate(${point.x} ${point.y})`}
                role="button"
                tabIndex={0}
                aria-label={
                  node.kind === "followUp"
                    ? `Follow-up, ${node.followUp.title}`
                    : `Thread, ${threadTitles.get(node.key) || node.recordedTitle || "untitled"}`
                }
                aria-current={selected ? "true" : undefined}
                className="group/node cursor-pointer outline-none"
                onClick={() => {
                  if (!draggedRef.current) open(node);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  open(node);
                }}
              >
                <circle r={Math.max(radius, HIT_RADIUS)} className="fill-transparent" />
                <circle
                  r={radius + 4}
                  fill="none"
                  strokeWidth={2}
                  className={cn(
                    "stroke-ring",
                    selected
                      ? "opacity-100"
                      : "opacity-0 group-hover/node:opacity-40 group-focus-visible/node:opacity-100",
                  )}
                />
                {node.kind === "followUp" ? (
                  <FollowUpMark followUp={node.followUp} />
                ) : (
                  <rect
                    x={-THREAD_HALF}
                    y={-THREAD_HALF}
                    width={THREAD_HALF * 2}
                    height={THREAD_HALF * 2}
                    rx={1.5}
                    className="fill-muted-foreground/70"
                  />
                )}
                <text
                  x={radius + 6}
                  dominantBaseline="middle"
                  strokeWidth={3}
                  className={cn(
                    LABEL_SCALE_CLASS,
                    "origin-left stroke-background [paint-order:stroke]",
                    node.kind === "thread"
                      ? "fill-muted-foreground text-3xs"
                      : isFollowUpClosed(node.followUp)
                        ? "fill-muted-foreground text-2xs"
                        : "fill-foreground text-2xs font-medium",
                    labelVisibility,
                  )}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground">
          <LegendSwatch className="rounded-full bg-primary" label="Open" />
          <LegendSwatch className="rounded-full bg-warning" label="Back now" />
          <LegendSwatch className="rounded-full border-2 border-primary" label="Picked up" />
          {props.showClosed ? (
            <>
              <LegendSwatch className="rounded-full bg-success/60" label="Done" />
              <LegendSwatch className="rounded-full bg-muted-foreground/45" label="Dropped" />
            </>
          ) : null}
          <LegendSwatch className="rounded-xs bg-muted-foreground/70" label="Thread" />
        </div>
        <div className="pointer-events-auto flex shrink-0 gap-1">
          <GraphControl label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
            <MinusIcon />
          </GraphControl>
          <GraphControl label="Zoom in" onClick={() => zoomBy(1.4)}>
            <PlusIcon />
          </GraphControl>
          <GraphControl label="Fit to view" onClick={fit}>
            <MaximizeIcon />
          </GraphControl>
        </div>
      </div>
    </div>
  );
}
