import type { ThreadFindMatch } from "@t3tools/client-runtime/thread-find";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  splitMarkdownHighlight,
  type MarkdownTextHighlight,
} from "@t3tools/mobile-markdown-text/highlight";
import { useMemo } from "react";
import { Text as NativeText, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { threadFindRowExcerpt } from "./thread-find-feed";

/** Highlights for one find query. Rows add which of their ranges is current. */
export type ThreadFindHighlighter = Omit<MarkdownTextHighlight, "current">;

/** What the feed needs to highlight matches and reveal the current one. */
export interface ThreadFeedFind {
  readonly highlighter: ThreadFindHighlighter;
  readonly matchedItemKeys: ReadonlySet<string>;
  /** Keeps a text excerpt from when it was selected; see threadFindRowExcerpt. */
  readonly current: ThreadFindMatch | null;
  /** Bumped when the reader asks for a match, so the feed goes there even if it is the same one. */
  readonly navigation: number;
}

export function threadFindColors(appearance: "light" | "dark") {
  return appearance === "dark"
    ? { color: "rgba(250, 204, 21, 0.3)", currentColor: "rgba(251, 146, 60, 0.6)" }
    : { color: "rgba(250, 204, 21, 0.4)", currentColor: "rgba(249, 115, 22, 0.55)" };
}

/** Marks matches inside a parent Text, which keeps its own font and color. */
export function ThreadFindText(props: {
  readonly text: string;
  readonly highlight: MarkdownTextHighlight | undefined;
}) {
  const { highlight } = props;
  if (highlight === undefined) return props.text;
  const ranges = highlight.find(props.text);
  if (ranges.length === 0) return props.text;
  let offset = 0;
  return splitMarkdownHighlight(props.text, ranges, highlight.current).map((segment) => {
    const start = offset;
    offset += segment.text.length;
    return segment.mark ? (
      <NativeText
        key={start}
        style={{
          backgroundColor: segment.mark === "current" ? highlight.currentColor : highlight.color,
        }}
      >
        {segment.text}
      </NativeText>
    ) : (
      segment.text
    );
  });
}

function detailLabel(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "command_execution":
      return "Output";
    case "file_change":
      return "Diff";
    case "dynamic_tool":
      return "Tool input and output";
    case "handoff":
      return "Summary";
    default:
      return "Details";
  }
}

/**
 * The lines around the current match of a work row. Command output, diffs and
 * tool I/O never reach the client, so this is the only place they show.
 */
export function ThreadFindExcerptCard(props: {
  readonly match: ThreadFindMatch;
  readonly item: OrchestrationV2TurnItem;
  readonly highlight: Pick<MarkdownTextHighlight, "find" | "currentColor">;
}) {
  const { match, item } = props;
  const { find } = props.highlight;
  const excerpt = useMemo(() => threadFindRowExcerpt(match, item, find), [find, item, match]);
  const detail = match.field === "detail";
  return (
    <View className="mt-1 mb-1.5 ml-7 gap-1 rounded-lg border border-border bg-subtle px-2.5 py-2">
      {detail ? (
        <Text className="font-t3-medium text-2xs text-foreground-muted">
          {`${detailLabel(item)}, line ${excerpt.line}`}
        </Text>
      ) : null}
      <Text
        selectable
        className="font-mono text-2xs leading-normal text-foreground"
        numberOfLines={8}
      >
        {excerpt.text.slice(0, excerpt.start)}
        <NativeText style={{ backgroundColor: props.highlight.currentColor }}>
          {excerpt.text.slice(excerpt.start, excerpt.end)}
        </NativeText>
        {excerpt.text.slice(excerpt.end)}
      </Text>
      {excerpt.totalLength !== undefined ? (
        <Text className="text-2xs text-foreground-muted">
          {`Only the first 256 KB of ${formatAttachmentSize(excerpt.totalLength)} is searchable`}
        </Text>
      ) : null}
    </View>
  );
}
