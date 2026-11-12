import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FollowUpId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ListTodoIcon } from "lucide-react";
import { memo } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel, formatChatTimestampTooltip } from "~/timestampFormat";
import { animateSidebarLayoutChanges } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

function BackSinceLabel(props: { returnedAt: string }) {
  const nowMinute = useNowMinute();
  const label = formatRelativeTimeLabel(props.returnedAt, Date.parse(`${nowMinute}:00.000Z`));
  return <>back {label === "just now" ? "now" : label.replace(/ ago$/, "")}</>;
}

/** A returned follow-up in the inbox. It never drags; it registers so drags project around it. */
export const SidebarFollowUpRow = memo(function SidebarFollowUpRow(props: {
  sortableId: string;
  followUpId: FollowUpId;
  title: string;
  returnedAt: string;
  timestampFormat: TimestampFormat;
  isActive: boolean;
  onOpen: (followUpId: FollowUpId) => void;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: props.sortableId,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      className="list-none"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-sidebar-row={props.sortableId}
              data-testid="sidebar-row-follow-up"
              aria-current={props.isActive ? "page" : undefined}
              aria-label={`Follow-up, ${props.title}`}
              onClick={() => props.onOpen(props.followUpId)}
              className={cn(
                "group/sidebar-row flex h-9 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                props.isActive
                  ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
                  : "text-sidebar-foreground hover:bg-sidebar-row-hover",
              )}
            />
          }
        >
          <ListTodoIcon aria-hidden className="size-4 shrink-0 text-info-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.title}</span>
          <span className="shrink-0 text-xs text-secondary-label tabular-nums">
            <BackSinceLabel returnedAt={props.returnedAt} />
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">
          Follow-up, back since{" "}
          {formatChatTimestampTooltip(props.returnedAt, props.timestampFormat)}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
});
