/**
 * Row primitives. Every thread row, top level or nested, live or settled,
 * uses the same two-line `ThreadRow`: title with a status slot, then a
 * subtitle. Hierarchy comes only from indentation, connector lines, and the
 * disclosure on a lineage root, never from a lighter row treatment.
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
    return { label: "Superseded", icon: null, className: "text-sidebar-muted-foreground" };
  }
  if (thread.settled) return null;
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
      return { label: "Stopped", icon: null, className: "text-sidebar-muted-foreground" };
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

export function branchLabel(thread: ProtoThread): string {
  const slug = thread.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-");
  return `hauke/${slug}`;
}

function rowSurfaceClass(active: boolean): string {
  return cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    active
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
  );
}

/**
 * The leading disclosure slot on a lineage-root row that has descendants. On the phone it is a
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

/** The one thread row. Same height, type, and affordances wherever it sits. */
export function ThreadRow({
  thread,
  index,
  active,
  onSelect,
  leading,
  subtitle,
  subtitleAttention = false,
  trailing,
  attemptsControl,
}: {
  readonly thread: ProtoThread;
  readonly index: WorkIndex;
  readonly active: boolean;
  readonly onSelect: () => void;
  /** Disclosure slot for coordinators; ordinary rows keep the same inset without it. */
  readonly leading?: ReactNode;
  /** Second line: project and branch, coordinator counts, or search context. */
  readonly subtitle: string;
  readonly subtitleAttention?: boolean;
  /** Replaces the status label, e.g. a nested coordinator's counts. */
  readonly trailing?: ReactNode;
  readonly attemptsControl?: {
    readonly count: number;
    readonly expanded: boolean;
    readonly onToggle: () => void;
  };
}) {
  const status = threadStatus(index, thread);
  return (
    <li className="list-none py-px">
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
        className={cn(rowSurfaceClass(active), "flex h-12 items-stretch")}
      >
        {leading}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 pe-2.5",
            leading === undefined ? "ps-2.5" : "ps-0.5",
          )}
        >
          <ProjectGlyph project={thread.project} />
          <span className="flex min-w-0 flex-1 flex-col justify-center">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm font-medium",
                  active ? "text-foreground" : "text-foreground/90",
                )}
              >
                {thread.title}
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
                    "inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-[11px] tabular-nums text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
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
            </span>
            <span
              className={cn(
                "truncate text-xs",
                subtitleAttention ? "text-amber-700 dark:text-amber-300" : "text-secondary-label",
              )}
            >
              {subtitle}
            </span>
          </span>
        </div>
      </div>
    </li>
  );
}

/** "Viewing: title" under a collapsed container that hides the selected row. */
export function ViewingRow({
  title,
  onReveal,
  device,
}: {
  readonly title: string;
  readonly onReveal: () => void;
  readonly device: DeviceKind;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onReveal}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-left text-xs text-foreground/80 hover:bg-sidebar-row-hover hover:text-foreground",
          device === "phone" ? "h-9" : "h-7",
        )}
      >
        <CornerDownRightIcon
          aria-hidden
          className="size-3 shrink-0 text-sidebar-muted-foreground"
        />
        <span className="truncate">
          <span className="text-sidebar-muted-foreground">Viewing: </span>
          {title}
        </span>
      </button>
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
        className="mb-1 mt-2 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
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
