import { memo } from "react";
import { Platform, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import type { InboxFollowUp } from "../../state/follow-ups";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
} from "../threads/thread-list-v2-row-appearance";
import { FOLLOW_UP_ICON } from "./followUpPresentation";

/** A returned follow-up in the thread list's inbox, shaped like the thread rows around it. */
export const FollowUpInboxRow = memo(function FollowUpInboxRow(props: {
  readonly entry: InboxFollowUp;
  readonly timeLabel: string;
  readonly pane?: "screen" | "sidebar";
  readonly showTrailingDivider: boolean;
  readonly onOpen: (entry: InboxFollowUp) => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  // Android draws every row as a card; iOS only in the sidebar.
  const card = sidebarPane || Platform.OS === "android";
  const { followUp } = props.entry;
  const content = (
    <View className="flex-row items-center gap-2">
      <SymbolView
        name={FOLLOW_UP_ICON}
        size={14}
        tintColorClassName="accent-adaptive-violet-600-400"
        type="monochrome"
        weight="semibold"
      />
      <Text
        className={cn(
          "flex-1 text-base font-t3-medium",
          sidebarPane ? "text-drawer-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {followUp.title}
      </Text>
      <Text
        className={cn(
          "text-xs",
          sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
        )}
      >
        back since {props.timeLabel}
      </Text>
    </View>
  );
  return (
    <View
      className={sidebarPane ? "bg-drawer" : "bg-screen"}
      style={card ? THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE : undefined}
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`Follow-up: ${followUp.title}, back since ${props.timeLabel}`}
        accessibilityHint="Opens the follow-up."
        interactionClassName={sidebarPane ? "bg-thread-hover" : "bg-row-hover"}
        onPress={() => props.onOpen(props.entry)}
        style={sidebarPane ? THREAD_LIST_V2_SIDEBAR_ROW_STYLE : undefined}
      >
        {sidebarPane ? (
          content
        ) : (
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{content}</View>
            {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider ? (
              <View className="ml-5 h-px bg-border-subtle" />
            ) : null}
          </View>
        )}
      </RowPressable>
    </View>
  );
});
