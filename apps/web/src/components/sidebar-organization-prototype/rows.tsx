/**
 * Row primitives borrowed from the real sidebar's visual language: the
 * three-line card for top-level threads, the slim row for nested and settled
 * threads, and the thin section header used for efforts and shelves.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CornerDownRightIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { PROJECTS, type ProtoThread } from "./data";
import type { WorkIndex } from "./model";
import { isSuperseded } from "./model";
import type { DeviceKind } from "./store";

export function ProjectGlyph({
  project,
  className,
}: {
  readonly project: ProtoThread["project"];
  readonly className?: string;
}) {
  const p = PROJECTS[project];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[8px] font-semibold leading-none",
        p.className,
        className,
      )}
    >
      {p.glyph}
    </span>
  );
}

interface StatusPresentation {
  readonly label: string;
  readonly icon: "working" | "done" | null;
  readonly className: string;
}

/** The label a row shows in its status slot; null means the row shows its age instead. */
export function threadStatus(index: WorkIndex, thread: ProtoThread): StatusPresentation | null {
  if (isSuperseded(index, thread)) {
    return { label: "Superseded", icon: null, className: "text-sidebar-muted-foreground/70" };
  }
  switch (thread.state) {
    case "working":
      return { label: "Working", icon: "working", className: "text-sky-600 dark:text-sky-400" };
    case "blocked":
      return { label: "Needs you", icon: null, className: "text-amber-700 dark:text-amber-300" };
    case "failed":
      return { label: "Failed", icon: null, className: "text-red-700 dark:text-red-300" };
    case "completed":
      return thread.unread
        ? { label: "Done", icon: "done", className: "text-emerald-700 dark:text-emerald-300" }
        : null;
    case "stopped":
      return { label: "Stopped", icon: null, className: "text-sidebar-muted-foreground/70" };
    case "idle":
      return null;
  }
}

function StatusLabel({
  status,
  age,
}: {
  readonly status: StatusPresentation | null;
  readonly age: string;
}) {
  if (status === null) {
    return <span className="text-xs tabular-nums text-secondary-label">{age}</span>;
  }
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", status.className)}>
      {status.icon === "working" ? (
        <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
      ) : status.icon === "done" ? (
        <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
      ) : null}
      {status.label}
    </span>
  );
}

function branchLabel(thread: ProtoThread): string {
  const slug = thread.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-");
  return `hauke/${slug}`;
}

export function rowSurfaceClass(active: boolean, recede: boolean): string {
  return cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    active
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : recede
        ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
  );
}

/**
 * The leading disclosure slot on a coordinator card. On the phone it is a
 * 44-point target that is always visible; on the desktop the same slot holds
 * a chevron that appears on hover, and stays faintly visible while collapsed
 * so a folded tray is still discoverable.
 */
export function DisclosureSlot({
  device,
  expanded,
  onToggle,
  label,
}: {
  readonly device: DeviceKind;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "flex shrink-0 items-center justify-center self-stretch text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:opacity-100",
        device === "phone"
          ? "w-11 hover:bg-sidebar-row-hover"
          : cn(
              "w-6 transition-opacity group-hover/sidebar-row:opacity-100",
              expanded ? "opacity-0" : "opacity-50",
            ),
      )}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          device === "phone" ? "size-4" : "size-3.5",
          "transition-transform",
          expanded && "rotate-90",
        )}
      />
    </button>
  );
}

export function ThreadCardRow({
  thread,
  index,
  active,
  onSelect,
  leading,
  summary,
  summaryAttention,
  viewing,
  onRevealViewing,
}: {
  readonly thread: ProtoThread;
  readonly index: WorkIndex;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly leading?: ReactNode;
  /** Roll-up such as `2 working · 1 needs you`, shown on coordinators. */
  readonly summary?: string | null;
  readonly summaryAttention?: boolean;
  /** Title of the selected child hidden by an explicit collapse. */
  readonly viewing?: string | null;
  readonly onRevealViewing?: () => void;
}) {
  const status = threadStatus(index, thread);
  const recede = status === null && !active;
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        className={cn(rowSurfaceClass(active, recede), "flex")}
      >
        {leading}
        <div
          className={cn(
            "min-w-0 flex-1 py-[var(--sidebar-content-inset)] pe-[var(--sidebar-row-content-inset)]",
            leading === undefined ? "ps-[var(--sidebar-row-content-inset)]" : "ps-1",
          )}
        >
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <ProjectGlyph project={thread.project} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs text-secondary-label",
                recede ? "font-normal" : "font-medium",
              )}
            >
              {PROJECTS[thread.project].title}
            </span>
            <span className="ml-auto flex h-5 shrink-0 items-center">
              <StatusLabel status={status} age={thread.age} />
            </span>
          </div>
          <div className="flex h-5 min-w-0 items-center">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                recede ? "font-normal text-secondary-label" : "font-medium text-foreground/90",
              )}
            >
              {thread.title}
            </span>
          </div>
          <div className="flex h-5 min-w-0 items-center gap-1 text-xs">
            {summary !== undefined && summary !== null ? (
              <span
                className={cn(
                  "truncate tabular-nums",
                  summaryAttention ? "text-amber-700 dark:text-amber-300" : "text-secondary-label",
                )}
              >
                {summary}
              </span>
            ) : summary === null ? (
              <span className="truncate text-secondary-label/70">No live delegated work</span>
            ) : (
              <span className="truncate font-mono text-[11px] text-secondary-label/70">
                {branchLabel(thread)}
              </span>
            )}
          </div>
          {viewing !== undefined && viewing !== null ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRevealViewing?.();
              }}
              className="flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm text-xs text-foreground/80 hover:text-foreground"
            >
              <CornerDownRightIcon
                aria-hidden
                className="size-3 shrink-0 text-sidebar-muted-foreground"
              />
              <span className="truncate">
                <span className="text-sidebar-muted-foreground">Viewing: </span>
                {viewing}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function ThreadSlimRow({
  thread,
  index,
  active,
  device,
  onSelect,
  trailing,
  context,
  dimmed = false,
  attemptsControl,
}: {
  readonly thread: ProtoThread;
  readonly index: WorkIndex;
  readonly active: boolean;
  readonly device: DeviceKind;
  readonly onSelect: () => void;
  /** Replaces the status label, e.g. a nested coordinator's counts. */
  readonly trailing?: ReactNode;
  /** Second line under the title for search results. */
  readonly context?: string;
  readonly dimmed?: boolean;
  readonly attemptsControl?: {
    readonly count: number;
    readonly expanded: boolean;
    readonly onToggle: () => void;
  };
}) {
  const status = threadStatus(index, thread);
  const recede = (status === null || dimmed) && !active;
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          rowSurfaceClass(active, recede),
          "flex items-center gap-2.5 px-2.5",
          device === "phone" ? "h-11" : context === undefined ? "h-9" : "h-11",
        )}
      >
        <span
          className={cn(
            "shrink-0 transition-opacity",
            dimmed &&
              !active &&
              "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
          )}
        >
          <ProjectGlyph project={thread.project} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-sm group-hover/sidebar-row:text-foreground",
              active
                ? "font-medium text-foreground"
                : recede
                  ? "text-secondary-label/70"
                  : "font-medium text-foreground/90",
            )}
          >
            {thread.title}
          </span>
          {context !== undefined ? (
            <span className="truncate text-[11px] text-sidebar-muted-foreground">{context}</span>
          ) : null}
        </span>
        {attemptsControl !== undefined ? (
          <button
            type="button"
            aria-expanded={attemptsControl.expanded}
            aria-label={`${attemptsControl.count} earlier attempt${attemptsControl.count === 1 ? "" : "s"}`}
            onClick={(event) => {
              event.stopPropagation();
              attemptsControl.onToggle();
            }}
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[11px] tabular-nums text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              device === "phone" ? "h-8" : "h-5",
              attemptsControl.expanded && "text-sidebar-foreground",
            )}
          >
            <RotateCcwIcon aria-hidden className="size-3" />
            {attemptsControl.count}
          </button>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">
          {trailing ?? <StatusLabel status={status} age={thread.age} />}
        </span>
      </div>
    </li>
  );
}

/** Thin collapsible header for an effort section, Other delegated work, or Past efforts. */
export function SectionHeader({
  title,
  expanded,
  onToggle,
  device,
  summary,
  attention = false,
  closed = false,
  muted = false,
}: {
  readonly title: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly device: DeviceKind;
  readonly summary: string | null;
  readonly attention?: boolean;
  readonly closed?: boolean;
  readonly muted?: boolean;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          device === "phone" ? "h-11" : "h-7",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <span
          className={cn(
            "min-w-0 truncate font-medium",
            muted ? "text-sidebar-muted-foreground/70" : "text-sidebar-foreground/90",
          )}
        >
          {title}
        </span>
        {closed ? (
          <span className="shrink-0 rounded-sm border border-sidebar-border/80 px-1 py-px text-[10px] leading-none text-sidebar-muted-foreground/80">
            Closed
          </span>
        ) : null}
        {summary !== null ? (
          <span
            className={cn(
              "ms-auto shrink-0 truncate tabular-nums",
              attention ? "text-amber-700 dark:text-amber-300" : "text-sidebar-muted-foreground",
            )}
          >
            {summary}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** The Settled shelf divider, matching the real sidebar's shelf toggle. */
export function ShelfHeader({
  label,
  count,
  expanded,
  onToggle,
}: {
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
      >
        <span className="text-xs font-medium text-muted-foreground/50">
          {expanded ? label : `${label} (${count})`}
        </span>
        <span className="h-px flex-1 bg-sidebar-border/60" />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 text-muted-foreground/50 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
    </li>
  );
}
