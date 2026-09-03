import type {
  SidebarOrchestrationHistoryItem,
  SidebarOrchestrationSectionItem,
  SidebarOrchestrationViewingItem,
} from "@t3tools/client-runtime/state/threads";
import { ChevronRightIcon, CornerDownRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export function SidebarOrchestrationSectionRow(props: {
  readonly item: SidebarOrchestrationSectionItem;
  readonly onToggle: (containerId: string) => void;
}) {
  const { item } = props;
  return (
    <li
      className="list-none border-s border-sidebar-border/70 ps-1.5"
      style={{ marginInlineStart: `${item.depth * 0.75}rem` }}
    >
      <button
        type="button"
        aria-expanded={item.expanded}
        onClick={() => props.onToggle(item.containerId)}
        data-testid="sidebar-effort-header"
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", item.expanded && "rotate-90")}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium",
            item.muted ? "text-sidebar-muted-foreground/70" : "text-sidebar-foreground/90",
          )}
        >
          {item.title}
        </span>
        {item.closed ? (
          <span className="shrink-0 text-sidebar-muted-foreground/60">Closed</span>
        ) : null}
        {item.summary !== null ? (
          <span
            className={cn(
              "shrink-0 truncate tabular-nums",
              item.attention
                ? "text-amber-700 dark:text-amber-300"
                : "text-sidebar-muted-foreground",
            )}
          >
            {item.summary}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function SidebarOrchestrationHistoryRow(props: {
  readonly item: SidebarOrchestrationHistoryItem;
}) {
  return (
    <li
      className="flex h-8 list-none min-w-0 items-center gap-2 border-s border-sidebar-border/50 px-2 text-xs text-sidebar-muted-foreground"
      style={{ marginInlineStart: `${props.item.depth * 0.75}rem` }}
    >
      <span className="min-w-0 flex-1 truncate">{props.item.title}</span>
      <span className="shrink-0 tabular-nums text-sidebar-muted-foreground/70">
        {props.item.summary}
      </span>
    </li>
  );
}

export function SidebarViewingRow(props: {
  readonly item: SidebarOrchestrationViewingItem;
  readonly title: string;
  readonly onReveal: (containerIds: ReadonlyArray<string>) => void;
}) {
  return (
    <li className="list-none ps-[1.375rem]">
      <button
        type="button"
        onClick={() => props.onReveal(props.item.containerIds)}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-left text-xs text-foreground/80 hover:bg-sidebar-row-hover hover:text-foreground"
      >
        <CornerDownRightIcon
          aria-hidden
          className="size-3 shrink-0 text-sidebar-muted-foreground"
        />
        <span className="truncate">
          <span className="text-sidebar-muted-foreground">Viewing: </span>
          {props.title}
        </span>
      </button>
    </li>
  );
}
