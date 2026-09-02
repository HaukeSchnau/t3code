/**
 * Nested children under an ordinary parent row in the sidebar.
 *
 * The parent row is a normal thread row; this component renders after it and
 * only lays out children the lineage layout says nest. Rows are supplied by
 * the caller so the same `SidebarThreadRow` navigates, renames and settles
 * exactly as at the top level. Efforts appear as slim headers between rows
 * only when a coordinator opened one; a single delegated child nests bare.
 */
import {
  groupChildrenByEffort,
  type SidebarLineageLayout,
  type ThreadLineage,
} from "@t3tools/client-runtime/state/threads";
import { ChevronRight } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

function EffortHeaderRow({
  title,
  closed,
  summary,
  attention,
  expanded,
  onToggle,
}: {
  readonly title: string;
  readonly closed: boolean;
  readonly summary: string | null;
  readonly attention: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      data-testid="sidebar-effort-header"
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
    >
      <ChevronRight
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium",
          closed ? "text-sidebar-muted-foreground/70" : "text-sidebar-foreground/90",
        )}
      >
        {title}
      </span>
      <span
        className={cn(
          "shrink-0 truncate tabular-nums",
          closed
            ? "text-sidebar-muted-foreground/60"
            : attention
              ? "text-amber-700 dark:text-amber-300"
              : "text-sidebar-muted-foreground",
        )}
      >
        {closed ? "Closed" : summary}
      </span>
    </button>
  );
}

function NestedRows({
  keys,
  layout,
  renderRow,
}: {
  readonly keys: ReadonlyArray<string>;
  readonly layout: SidebarLineageLayout;
  readonly renderRow: (threadKey: string) => ReactNode;
}) {
  return (
    <ul className="flex flex-col gap-px" role="list">
      {keys.map((key) => {
        const children = layout.childrenByParentKey.get(key);
        return (
          <Fragment key={key}>
            {renderRow(key)}
            {children !== undefined && children.length > 0 ? (
              <li className="ms-3 list-none border-s border-sidebar-border/70 ps-2">
                <NestedRows keys={children} layout={layout} renderRow={renderRow} />
              </li>
            ) : null}
          </Fragment>
        );
      })}
    </ul>
  );
}

export function SidebarLineageGroup({
  parentKey,
  lineage,
  layout,
  renderRow,
  effortSummary,
  className,
}: {
  readonly parentKey: string;
  readonly lineage: ThreadLineage;
  readonly layout: SidebarLineageLayout;
  /** Must return an `<li>`; the real sidebar row already is one. */
  readonly renderRow: (threadKey: string) => ReactNode;
  /** Roll-up for an effort header, e.g. `2 working · 1 needs you`. */
  readonly effortSummary: (memberKeys: ReadonlyArray<string>) => {
    readonly label: string | null;
    readonly attention: boolean;
  };
  readonly className?: string;
}) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const childKeys = layout.childrenByParentKey.get(parentKey);
  if (childKeys === undefined || childKeys.length === 0) return null;
  const groups = groupChildrenByEffort(lineage, parentKey, childKeys);

  return (
    <div
      className={cn("ms-3 mt-0.5 border-s border-sidebar-border/70 ps-2", className)}
      data-testid="sidebar-lineage-group"
    >
      <ul className="flex flex-col gap-px" role="list">
        {groups.map((group) => {
          if (group.effort === null) {
            return (
              <li key="ungrouped" className="list-none">
                <NestedRows keys={group.memberKeys} layout={layout} renderRow={renderRow} />
              </li>
            );
          }
          const effort = group.effort;
          const closed = effort.closedAt !== null;
          const expanded = toggled.has(effort.effortId) ? closed : !closed;
          const summary = effortSummary(group.memberKeys);
          return (
            <li key={effort.effortId} className="list-none">
              <EffortHeaderRow
                title={effort.title}
                closed={closed}
                summary={summary.label}
                attention={summary.attention}
                expanded={expanded}
                onToggle={() =>
                  setToggled((current) => {
                    const next = new Set(current);
                    if (next.has(effort.effortId)) next.delete(effort.effortId);
                    else next.add(effort.effortId);
                    return next;
                  })
                }
              />
              {expanded ? (
                <div className="ms-2">
                  <NestedRows keys={group.memberKeys} layout={layout} renderRow={renderRow} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
