import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FollowUpId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ListTodoIcon } from "lucide-react";
import { memo } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { formatRelativeTime, formatChatTimestampTooltip } from "~/timestampFormat";
import { animateSidebarLayoutChanges } from "../Sidebar.logic";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

function BackSinceLabel(props: { returnedAt: string }) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const parts = formatRelativeTime(props.returnedAt, Date.parse(`${nowMinute}:00.000Z`), m);
  return parts === null || parts.suffix === null
    ? gt("back now", { $context: "a follow-up returned to the inbox just now" })
    : gt("back {duration}", { duration: parts.value });
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
  const gt = useGT();
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
            <SidebarMenuButton
              type="button"
              isActive={props.isActive}
              data-sidebar-row={props.sortableId}
              data-testid="sidebar-row-follow-up"
              aria-current={props.isActive ? "page" : undefined}
              aria-label={gt("Follow-up, {title}", { title: props.title })}
              onClick={() => props.onOpen(props.followUpId)}
              // The thread rows beside it are 36px tall.
              className="h-9 select-none"
            />
          }
        >
          <ListTodoIcon aria-hidden className="size-4" />
          <span className="min-w-0 flex-1 truncate text-(--sidebar-thread-title-foreground)">
            {props.title}
          </span>
          <span className="shrink-0 text-meta text-secondary-label tabular-nums">
            <BackSinceLabel returnedAt={props.returnedAt} />
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">
          <T>
            Follow-up, back since{" "}
            <Var>{formatChatTimestampTooltip(props.returnedAt, props.timestampFormat)}</Var>
          </T>
        </TooltipPopup>
      </Tooltip>
    </li>
  );
});
