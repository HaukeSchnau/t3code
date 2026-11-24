import type { HtmlRenderPage } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { RowPressable } from "../../components/ui/RowPressable";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { PAGE_ICON } from "./pagePresentation";

/**
 * A page in a Pages list. Inside one thread its section says whether it is new; across threads
 * the row names its thread, marks it new, and opens the thread too.
 */
export function HtmlRenderPageRow(props: {
  readonly page: HtmlRenderPage;
  readonly onOpen: () => void;
  /** Set for lists across threads. */
  readonly onOpenThread?: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { page, onOpenThread } = props;
  const nowMs = useNowMinuteMs();
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  const markNew = onOpenThread !== undefined && page.seenAt === null;
  const threadTitle = page.threadTitle.trim() || gt("Untitled thread");
  const facts = [
    onOpenThread === undefined ? null : threadTitle,
    page.versionCount > 1
      ? gt("{count, plural, one {{count} version} other {{count} versions}}", {
          count: page.versionCount,
        })
      : null,
  ]
    .filter((fact) => fact !== null)
    .join(" · ");
  const time = relativeTime(page.latestPublishedAt, nowMs, messages);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[
        page.title,
        page.ask?.text,
        markNew ? gt("New", { $context: "page not seen yet" }) : null,
        facts,
        time,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={gt("Opens the page.")}
      // VoiceOver cannot focus the thread button inside the row, so the row offers it as an action.
      accessibilityActions={
        onOpenThread === undefined
          ? undefined
          : [{ name: "openThread", label: gt("Open thread {thread}", { thread: threadTitle }) }]
      }
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "openThread") onOpenThread?.();
      }}
      onPress={props.onOpen}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <ListRowLayout
        leading={
          <SymbolView
            name={page.ask === null ? PAGE_ICON : "questionmark.bubble"}
            size={Platform.OS === "android" ? 22 : 20}
            tintColorClassName={
              page.ask === null ? "accent-icon" : "accent-adaptive-indigo-600-300"
            }
            type="monochrome"
          />
        }
        label={page.title}
        description={page.ask?.text}
        meta={
          markNew || facts !== "" ? (
            <View className="flex-row items-center gap-1.5">
              {markNew ? (
                <Text textRole="footnote" className="font-t3-bold text-primary-text">
                  {gt("New", { $context: "page not seen yet" })}
                </Text>
              ) : null}
              {facts !== "" ? (
                <Text
                  textRole="footnote"
                  className="min-w-0 shrink text-foreground-muted"
                  numberOfLines={1}
                >
                  {facts}
                </Text>
              ) : null}
            </View>
          ) : undefined
        }
        detail={time}
        accessory={
          onOpenThread === undefined ? (
            <SymbolView
              name="chevron.right"
              size={16}
              tintColorClassName="accent-chevron"
              type="monochrome"
              weight="semibold"
            />
          ) : (
            <IconButton
              accessibilityLabel={gt("Open thread {thread}", { thread: threadTitle })}
              icon="text.bubble"
              tintColorClassName="accent-icon"
              onPress={onOpenThread}
            />
          )
        }
      />
    </RowPressable>
  );
}
