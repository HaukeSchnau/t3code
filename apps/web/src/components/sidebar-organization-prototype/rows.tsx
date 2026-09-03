/**
 * Row primitives. Every thread row, root or nested, live or settled, is the
 * production regular thread card (`SidebarThreadRow`'s card variant): the
 * 4.875rem content block with project line and status slot, title, then
 * branch and provider mark. Hierarchy comes only from the leading disclosure
 * gutter, indentation, and connector lines, never from a lighter row.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CornerDownRightIcon,
  GitBranchIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ClaudeAI, OpenAI, OpenCodeIcon } from "../Icons";
import { PROJECTS, type ProtoThread, type ProviderKind } from "./data";
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

/** Production card surface: interaction owns the surface, status lives in the content. */
function rowSurfaceClass(active: boolean, recede: boolean): string {
  return cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    active
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : recede
        ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
  );
}

function ProviderMark({ provider }: { readonly provider: ProviderKind }) {
  const className = "size-3.5 opacity-60";
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden>
      {provider === "claude" ? (
        <ClaudeAI className={className} />
      ) : provider === "codex" ? (
        <OpenAI className={className} />
      ) : (
        <OpenCodeIcon className={className} />
      )}
    </span>
  );
}

/**
 * The title and branch lines of a parent root indent by the project glyph
 * plus its gap, so they start exactly where the project name starts.
 */
export const ROOT_INDENT_CLASS = "ps-[1.375rem]";

/**
 * The leading disclosure for a lineage root with descendants. It sits in a
 * gutter beside the card's title and branch lines only, so the project line
 * keeps the full card width and lines up with leaf roots. It is a sibling of
 * the navigation surface, not a child, and is visible at rest everywhere.
 */
export function RootDisclosure({
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
      onClick={onToggle}
      className={cn(
        // Top clears the row padding, card inset, project line and title gap;
        // bottom clears the card inset and row padding. The chevron centers
        // under the project glyph: a 16px column at the card inset on the
        // desktop, a 44px target centred on the same point on the phone.
        "absolute bottom-2.5 top-[2.125rem] z-20 flex items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
        device === "phone" ? "-left-1 w-11" : "left-[var(--sidebar-row-content-inset)] w-4",
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

/** The one thread row: the production regular card, wherever it sits. */
export function ThreadRow({
  thread,
  index,
  active,
  onSelect,
  gutter,
  branchLine,
  branchLineAttention = false,
  attemptsControl,
}: {
  readonly thread: ProtoThread;
  readonly index: WorkIndex;
  readonly active: boolean;
  readonly onSelect: () => void;
  /** Root disclosure when the row owns descendants; it overlays the gutter beside the title and branch lines. */
  readonly gutter?: ReactNode;
  /** Third line: the branch by default, or a collapsed root's recursive summary. */
  readonly branchLine?: string;
  readonly branchLineAttention?: boolean;
  readonly attemptsControl?: {
    readonly count: number;
    readonly expanded: boolean;
    readonly onToggle: () => void;
  };
}) {
  const status = threadStatus(index, thread);
  // Quiet ready rows recede, as in production; live and attention states keep full weight.
  const recede = status === null && !thread.unread && !active;
  return (
    <li className="relative list-none py-0.5">
      {gutter}
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
        className={cn(rowSurfaceClass(active, recede), "min-w-0 flex-1")}
      >
        <div className="relative z-10 h-[4.875rem] px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <ProjectGlyph project={thread.project} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-secondary-label text-xs",
                recede ? "font-normal" : "font-medium",
              )}
            >
              {PROJECTS[thread.project].title}
            </span>
            <span className="ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end text-xs">
              <StatusLabel status={status} age={thread.age} />
            </span>
          </div>
          <div className={cn(gutter !== undefined && ROOT_INDENT_CLASS)}>
            <div className="mt-1 flex min-w-0">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  recede ? "font-normal text-secondary-label" : "font-medium",
                  active || thread.unread
                    ? "text-foreground"
                    : recede
                      ? "text-secondary-label"
                      : "text-foreground/90",
                )}
              >
                {thread.title}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
              {branchLine !== undefined ? (
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate whitespace-nowrap tabular-nums",
                    branchLineAttention && "text-amber-700 dark:text-amber-300",
                  )}
                >
                  {branchLine}
                </span>
              ) : (
                <>
                  <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap">
                    {branchLabel(thread)}
                  </span>
                </>
              )}
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
              <span className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1">
                <ProviderMark provider={thread.provider} />
              </span>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Production search-result row: slim, non-canonical, the hit is still one thread. */
export function SearchResultRow({
  thread,
  active,
  context,
  onSelect,
}: {
  readonly thread: ProtoThread;
  readonly active: boolean;
  readonly context: string;
  readonly onSelect: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onSelect}
        aria-label={`${thread.title}, ${context}`}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <ProjectGlyph project={thread.project} />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <span className="min-w-0 max-w-[45%] shrink truncate text-xs text-muted-foreground/55">
          {context}
        </span>
      </button>
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
