import { createContext, memo, useContext, useMemo } from "react";
import { Image, Platform, ScrollView, Text, useColorScheme, View } from "react-native";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import { CopyTextButton } from "./CopyTextButton";
import {
  distributeMarkdownHighlight,
  markdownRunsHighlightCount,
  splitMarkdownHighlight,
  type MarkdownHighlightMark,
  type MarkdownTextHighlight,
} from "./markdownHighlight";
import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import {
  nativeMarkdownDocumentRuns,
  nativeMarkdownListItemBlocks,
  nativeMarkdownNodePosition,
} from "./nativeMarkdownText";
import { NativeMarkdownSelectableText } from "./NativeMarkdownSelectableText";
import type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  MarkdownImageRenderer,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "./SelectableMarkdownText.types";
import { useHighlightedCode, type HighlightedCode } from "./useHighlightedCode";

/** Set by SelectableMarkdownText so images anywhere in the block tree can use it. */
export const MarkdownImageRendererContext = createContext<MarkdownImageRenderer | null>(null);

const MONO_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

function nodeKey(node: MarkdownNode, index: number): string {
  return `${node.type}:${nativeMarkdownNodePosition(node, index)}`;
}

/** Code inside markdown scales with the base text size (12pt at the default 15pt body). */
function codeBlockFontSize(textStyle: NativeMarkdownTextStyle): number {
  return Math.max(10, Math.round(textStyle.fontSize * 0.8));
}

function codeBlockLineHeight(textStyle: NativeMarkdownTextStyle): number {
  return codeBlockFontSize(textStyle) + 6;
}

function nodeText(node: MarkdownNode): string {
  if (node.content !== undefined) {
    return node.content;
  }
  return (node.children ?? []).map(nodeText).join("");
}

function documentFor(node: MarkdownNode): MarkdownNode {
  return node.type === "document" ? node : { type: "document", children: [node] };
}

function selectableNodeRuns(node: MarkdownNode, skills: ReadonlyArray<SelectableMarkdownSkill>) {
  return nativeMarkdownDocumentRuns(documentFor(node), skills);
}

function codeBlockContent(node: MarkdownNode): string {
  return nodeText(node).replace(/\n$/, "");
}

function markColor(
  mark: MarkdownHighlightMark | null | undefined,
  highlight: MarkdownTextHighlight | undefined,
): string | undefined {
  if (!mark || !highlight) return undefined;
  return mark === "current" ? highlight.currentColor : highlight.color;
}

/**
 * How many highlight ranges a block renders, in the order its leaves render
 * them. It mirrors NativeMarkdownBlock, so the two change together.
 */
export function markdownBlockHighlightCount(
  node: MarkdownNode,
  skills: ReadonlyArray<SelectableMarkdownSkill>,
  find: MarkdownTextHighlight["find"],
): number {
  const sum = (nodes: ReadonlyArray<MarkdownNode>) =>
    nodes.reduce((total, child) => total + markdownBlockHighlightCount(child, skills, find), 0);
  switch (node.type) {
    case "document":
    case "blockquote":
    case "table_head":
    case "table_body":
    case "table_row":
    case "table_cell":
    case "list_item":
    case "task_list_item":
      return sum(node.children ?? []);
    case "list":
      return (node.children ?? []).reduce(
        (total, item) => total + sum(nativeMarkdownListItemBlocks(item)),
        0,
      );
    case "code_block":
      return find(codeBlockContent(node)).length;
    case "table":
      return collectTableRows(node).reduce(
        (total, row) =>
          total +
          (row.children ?? []).reduce(
            (cells, cell) =>
              cells + markdownRunsHighlightCount(selectableNodeRuns(cell, skills), find),
            0,
          ),
        0,
      );
    case "image":
    case "horizontal_rule":
      return 0;
    case "paragraph":
      if ((node.children ?? []).some((child) => child.type === "image")) {
        return inlineGroups(node.children ?? []).reduce(
          (total, group) =>
            total +
            (group.type === "image"
              ? 0
              : markdownRunsHighlightCount(selectableNodeRuns(group, skills), find)),
          0,
        );
      }
      return markdownRunsHighlightCount(selectableNodeRuns(node, skills), find);
    default:
      return markdownRunsHighlightCount(selectableNodeRuns(node, skills), find);
  }
}

function SelectableNode(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
  readonly highlight?: MarkdownTextHighlight | undefined;
}) {
  return (
    <NativeMarkdownSelectableText
      runs={selectableNodeRuns(props.node, props.skills)}
      textStyle={props.textStyle}
      onLinkPress={props.onLinkPress}
      highlight={props.highlight}
    />
  );
}

type MarkedCodeToken = MarkdownHighlightedToken & { readonly mark?: MarkdownHighlightMark | null };

/** Cuts each line's tokens at range boundaries. Lines without a range keep their token array. */
function markCodeLines(
  lines: HighlightedCode,
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  current: number,
): ReadonlyArray<ReadonlyArray<MarkedCodeToken>> {
  let lineStart = 0;
  return lines.map((tokens) => {
    const lineLength = tokens.reduce((length, token) => length + token.content.length, 0);
    const lineEnd = lineStart + lineLength;
    const offset = lineStart;
    lineStart = lineEnd + 1;
    if (!ranges.some((range) => range.start < lineEnd && range.end > offset)) return tokens;
    const marked: MarkedCodeToken[] = [];
    let tokenStart = offset;
    for (const token of tokens) {
      const tokenRanges = ranges.flatMap((range, index) =>
        range.start < tokenStart + token.content.length && range.end > tokenStart
          ? [{ start: range.start - tokenStart, end: range.end - tokenStart, index }]
          : [],
      );
      if (tokenRanges.length === 0) {
        marked.push(token);
      } else {
        const local = tokenRanges.findIndex((range) => range.index === current);
        for (const segment of splitMarkdownHighlight(token.content, tokenRanges, local)) {
          marked.push({ ...token, content: segment.text, mark: segment.mark });
        }
      }
      tokenStart += token.content.length;
    }
    return marked;
  });
}

function markedPlainCode(
  content: string,
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  highlight: MarkdownTextHighlight,
) {
  let offset = 0;
  return splitMarkdownHighlight(content, ranges, highlight.current).map((segment) => {
    const start = offset;
    offset += segment.text.length;
    return segment.mark ? (
      <MarkdownTextPrimitive
        key={start}
        style={{ backgroundColor: markColor(segment.mark, highlight) }}
      >
        {segment.text}
      </MarkdownTextPrimitive>
    ) : (
      segment.text
    );
  });
}

const HighlightedCodeLine = memo(function HighlightedCodeLine(props: {
  readonly tokens: ReadonlyArray<MarkedCodeToken>;
  readonly color: string;
  readonly newline: boolean;
  readonly highlight?: MarkdownTextHighlight | undefined;
}) {
  let offset = 0;
  const children = [];
  for (const token of props.tokens) {
    if (!token.content) continue;
    children.push(
      <MarkdownTextPrimitive
        key={offset}
        style={{
          color: token.color ?? props.color,
          fontFamily: MONO_FONT_FAMILY,
          fontStyle: token.fontStyle !== null && (token.fontStyle & 1) === 1 ? "italic" : "normal",
          fontWeight: token.fontStyle !== null && (token.fontStyle & 2) === 2 ? "700" : "400",
          backgroundColor: markColor(token.mark, props.highlight),
        }}
      >
        {token.content}
      </MarkdownTextPrimitive>,
    );
    offset += token.content.length;
  }
  return (
    <MarkdownTextPrimitive>
      {children}
      {props.newline ? "\n" : ""}
    </MarkdownTextPrimitive>
  );
});

function HighlightedCodeText(props: {
  readonly content: string;
  readonly highlighted: HighlightedCode | null;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlight?: MarkdownTextHighlight | undefined;
}) {
  // The text root provides inherited styles through context. A new style object
  // would rerender every token even when its completed line is unchanged.
  const fontSize = codeBlockFontSize(props.textStyle);
  const lineHeight = codeBlockLineHeight(props.textStyle);
  const style = useMemo(
    () => ({
      color: props.textStyle.codeColor,
      fontFamily: MONO_FONT_FAMILY,
      fontSize,
      lineHeight,
    }),
    [props.textStyle.codeColor, fontSize, lineHeight],
  );
  const highlight = props.highlight;
  const ranges = useMemo(
    () => (highlight ? highlight.find(props.content) : []),
    [highlight, props.content],
  );
  const highlightedLines = useMemo(
    () =>
      props.highlighted && highlight && ranges.length > 0
        ? markCodeLines(props.highlighted, ranges, highlight.current)
        : props.highlighted,
    [highlight, props.highlighted, ranges],
  );
  let offset = 0;
  const lines = [];
  if (highlightedLines) {
    for (const tokens of highlightedLines) {
      lines.push(
        <HighlightedCodeLine
          key={offset}
          tokens={tokens}
          color={props.textStyle.codeColor}
          newline={lines.length + 1 < highlightedLines.length}
          highlight={highlight}
        />,
      );
      offset += tokens.reduce((length, token) => length + token.content.length, 0) + 1;
    }
  }
  return (
    <MarkdownTextPrimitive
      // The native text rebuilds its attributed string only on layout, so a
      // current match that moves without changing the token split needs a remount.
      key={highlight?.current}
      uiTextView
      selectable
      selectionColor={props.textStyle.selectionColor}
      selectionHandleColor={props.textStyle.selectionHandleColor}
      style={style}
    >
      {highlightedLines
        ? lines
        : highlight && ranges.length > 0
          ? markedPlainCode(props.content, ranges, highlight)
          : props.content}
    </MarkdownTextPrimitive>
  );
}

function NativeCodeBlock(props: {
  readonly node: MarkdownNode;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly compact?: boolean;
  readonly highlight?: MarkdownTextHighlight | undefined;
}) {
  const content = codeBlockContent(props.node);
  const colorScheme = useColorScheme();
  const theme = colorScheme === "dark" ? "dark" : "light";
  const highlighted = useHighlightedCode(content, props.node.language, theme, props.highlightCode);
  const languageLabel = props.node.language?.toUpperCase() ?? "CODE";
  return (
    <View
      style={{
        backgroundColor: props.textStyle.codeBlockBackgroundColor,
        borderColor: props.textStyle.dividerColor,
        borderCurve: "continuous",
        borderRadius: 10,
        borderWidth: 1,
        marginVertical: props.compact ? 7 : 0,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          minHeight: 42,
          borderBottomColor: props.textStyle.dividerColor,
          borderBottomWidth: 1,
          paddingLeft: 14,
          paddingRight: 6,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <MarkdownTextPrimitive
          selectable
          selectionColor={props.textStyle.selectionColor}
          selectionHandleColor={props.textStyle.selectionHandleColor}
          style={{
            flex: 1,
            color: props.textStyle.mutedColor,
            fontFamily: MONO_FONT_FAMILY,
            fontSize: codeBlockFontSize(props.textStyle),
          }}
        >
          {languageLabel}
        </MarkdownTextPrimitive>
        <CopyTextButton
          accessibilityLabel={`Copy ${languageLabel.toLowerCase()} code`}
          text={content}
          tintColor={props.textStyle.mutedColor}
          copiedTintColor={props.textStyle.linkColor}
          backgroundColor={props.textStyle.codeBackgroundColor}
          borderColor={props.textStyle.dividerColor}
          buttonSize={34}
          iconSize={14}
        />
      </View>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === "android"}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
      >
        <HighlightedCodeText
          content={content}
          highlighted={highlighted}
          textStyle={props.textStyle}
          highlight={props.highlight}
        />
      </ScrollView>
    </View>
  );
}

function collectTableRows(node: MarkdownNode): MarkdownNode[] {
  const rows: MarkdownNode[] = [];
  const visit = (child: MarkdownNode) => {
    if (child.type === "table_row") {
      rows.push(child);
      return;
    }
    for (const nested of child.children ?? []) {
      visit(nested);
    }
  };
  visit(node);
  return rows;
}

function NativeTable(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
  readonly highlight?: MarkdownTextHighlight | undefined;
}) {
  const rows = collectTableRows(props.node);
  const cells = rows.flatMap((row) => row.children ?? []);
  const cellHighlights = distributeMarkdownHighlight(props.highlight, cells, (cell) =>
    props.highlight
      ? markdownRunsHighlightCount(selectableNodeRuns(cell, props.skills), props.highlight.find)
      : 0,
  );
  let cellIndex = 0;
  return (
    <ScrollView
      horizontal
      bounces={false}
      nestedScrollEnabled={Platform.OS === "android"}
      showsHorizontalScrollIndicator={false}
    >
      <View
        style={{
          borderColor: props.textStyle.dividerColor,
          borderCurve: "continuous",
          borderRadius: 8,
          borderWidth: 1,
          overflow: "hidden",
        }}
      >
        {rows.map((row, rowIndex) => (
          <View
            key={nodeKey(row, rowIndex)}
            style={{
              flexDirection: "row",
              backgroundColor: rowIndex === 0 ? props.textStyle.codeBackgroundColor : "transparent",
              borderTopColor: props.textStyle.dividerColor,
              borderTopWidth: rowIndex === 0 ? 0 : 1,
            }}
          >
            {(row.children ?? []).map((cell, columnIndex) => (
              <View
                key={nodeKey(cell, columnIndex)}
                style={{
                  width: 160,
                  borderLeftColor: props.textStyle.dividerColor,
                  borderLeftWidth: columnIndex === 0 ? 0 : 1,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                }}
              >
                <NativeMarkdownSelectableText
                  runs={selectableNodeRuns(cell, props.skills).map((run) =>
                    rowIndex === 0 || cell.isHeader ? { ...run, bold: true } : run,
                  )}
                  textStyle={props.textStyle}
                  onLinkPress={props.onLinkPress}
                  highlight={cellHighlights[cellIndex++]}
                />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function NativeMarkdownImage(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  const renderImage = useContext(MarkdownImageRendererContext);
  const href = props.node.href;
  if (!href) {
    return (
      <SelectableNode
        node={props.node}
        skills={props.skills}
        textStyle={props.textStyle}
        onLinkPress={props.onLinkPress}
      />
    );
  }

  if (renderImage) {
    const rendered = renderImage({
      href,
      alt: props.node.alt ?? null,
      title: props.node.title ?? null,
    });
    if (rendered != null) {
      return <>{rendered}</>;
    }
  }

  return (
    <View style={{ gap: 6 }}>
      <Image
        source={{ uri: href }}
        resizeMode="contain"
        accessibilityLabel={props.node.alt ?? props.node.title}
        style={{
          width: "100%",
          aspectRatio: 16 / 9,
          backgroundColor: props.textStyle.codeBackgroundColor,
          borderRadius: 10,
        }}
      />
      {props.node.alt ? (
        <MarkdownTextPrimitive
          selectable
          selectionColor={props.textStyle.selectionColor}
          selectionHandleColor={props.textStyle.selectionHandleColor}
          style={{
            color: props.textStyle.mutedColor,
            fontFamily: props.textStyle.fontFamily,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {props.node.alt}
        </MarkdownTextPrimitive>
      ) : null}
    </View>
  );
}

function inlineGroups(nodes: ReadonlyArray<MarkdownNode>): MarkdownNode[] {
  const groups: MarkdownNode[] = [];
  let inline: MarkdownNode[] = [];
  const flush = () => {
    if (inline.length === 0) {
      return;
    }
    groups.push({ type: "paragraph", children: inline });
    inline = [];
  };

  for (const node of nodes) {
    if (node.type === "image") {
      flush();
      groups.push(node);
    } else {
      inline.push(node);
    }
  }
  flush();
  return groups;
}

function NativeMixedParagraph(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
  readonly highlight?: MarkdownTextHighlight | undefined;
}) {
  const groups = inlineGroups(props.node.children ?? []);
  const groupHighlights = distributeMarkdownHighlight(props.highlight, groups, (group) =>
    props.highlight && group.type !== "image"
      ? markdownRunsHighlightCount(selectableNodeRuns(group, props.skills), props.highlight.find)
      : 0,
  );
  return (
    <View style={{ gap: 8 }}>
      {groups.map((child, index) =>
        child.type === "image" ? (
          <NativeMarkdownImage
            key={nodeKey(child, index)}
            node={child}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
          />
        ) : (
          <SelectableNode
            key={nodeKey(child, index)}
            node={child}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
            highlight={groupHighlights[index]}
          />
        ),
      )}
    </View>
  );
}

function NativeList(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly onLinkPress?: (href: string) => void;
  readonly depth: number;
  readonly highlight?: MarkdownTextHighlight | undefined;
}) {
  const items = props.node.children ?? [];
  const itemBlocks = items.map(nativeMarkdownListItemBlocks);
  const blockHighlights = distributeMarkdownHighlight(
    props.highlight,
    itemBlocks.flat(),
    (block) =>
      props.highlight ? markdownBlockHighlightCount(block, props.skills, props.highlight.find) : 0,
  );
  let blockIndex = 0;
  const ordered = props.node.ordered ?? false;
  const start = props.node.start ?? 1;
  const nested = props.depth > 0;
  return (
    <View
      style={{
        gap: nested ? 3 : 5,
      }}
    >
      {items.map((item, index) => {
        const taskMarker = item.type === "task_list_item";
        const marker = taskMarker
          ? item.checked
            ? "☑︎"
            : "☐︎"
          : ordered
            ? `${start + index}.`
            : props.depth % 3 === 1
              ? "◦"
              : props.depth % 3 === 2
                ? "▪︎"
                : "•";
        const markerWidth = ordered ? 28 : taskMarker ? 20 : 18;
        const markerOffset = taskMarker ? 3 : ordered ? 0 : 2;
        return (
          <View
            key={nodeKey(item, index)}
            style={{ alignItems: "flex-start", flexDirection: "row" }}
          >
            <View
              style={{
                width: markerWidth,
                height: props.textStyle.lineHeight,
                marginRight: 6,
                alignItems: ordered ? "flex-end" : "center",
                justifyContent: "flex-start",
              }}
            >
              <Text
                style={{
                  color: props.textStyle.color,
                  fontFamily: props.textStyle.fontFamily,
                  fontSize: taskMarker ? 14 : props.textStyle.fontSize,
                  lineHeight: props.textStyle.lineHeight,
                  fontVariant: ordered ? ["tabular-nums"] : undefined,
                  transform: [{ translateY: markerOffset }],
                }}
              >
                {marker}
              </Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              {(itemBlocks[index] ?? []).map((child, childIndex) => (
                <NativeMarkdownBlock
                  key={nodeKey(child, childIndex)}
                  node={child}
                  skills={props.skills}
                  textStyle={props.textStyle}
                  highlightCode={props.highlightCode}
                  onLinkPress={props.onLinkPress}
                  depth={props.depth + 1}
                  compact
                  highlight={blockHighlights[blockIndex++]}
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function NativeMarkdownBlock(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly onLinkPress?: (href: string) => void;
  readonly depth?: number;
  readonly compact?: boolean;
  readonly highlight?: MarkdownTextHighlight | undefined;
}) {
  const depth = props.depth ?? 0;
  const highlight = props.highlight;
  const childHighlights = (children: ReadonlyArray<MarkdownNode>) =>
    distributeMarkdownHighlight(highlight, children, (child) =>
      highlight ? markdownBlockHighlightCount(child, props.skills, highlight.find) : 0,
    );
  switch (props.node.type) {
    case "document": {
      const children = props.node.children ?? [];
      const highlights = childHighlights(children);
      return (
        <View style={{ gap: 8 }}>
          {children.map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
              highlight={highlights[index]}
            />
          ))}
        </View>
      );
    }
    case "code_block":
      return (
        <NativeCodeBlock
          node={props.node}
          textStyle={props.textStyle}
          highlightCode={props.highlightCode}
          compact={props.compact}
          highlight={highlight}
        />
      );
    case "table":
      return (
        <NativeTable
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
          highlight={highlight}
        />
      );
    case "image":
      return (
        <NativeMarkdownImage
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      );
    case "horizontal_rule":
      return (
        <View
          style={{
            height: 1,
            backgroundColor: props.textStyle.dividerColor,
          }}
        />
      );
    case "blockquote": {
      const children = props.node.children ?? [];
      const highlights = childHighlights(children);
      return (
        <View
          style={{
            borderLeftColor: props.textStyle.quoteMarkerColor,
            borderLeftWidth: 2,
            marginVertical: props.compact ? 4 : 0,
            paddingLeft: 11,
            paddingVertical: 2,
            gap: 6,
          }}
        >
          {children.map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
              compact
              highlight={highlights[index]}
            />
          ))}
        </View>
      );
    }
    case "list":
      return (
        <NativeList
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          highlightCode={props.highlightCode}
          onLinkPress={props.onLinkPress}
          depth={depth}
          highlight={highlight}
        />
      );
    case "paragraph":
      return (props.node.children ?? []).some((child) => child.type === "image") ? (
        <NativeMixedParagraph
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
          highlight={highlight}
        />
      ) : (
        <SelectableNode
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
          highlight={highlight}
        />
      );
    case "html_block":
    case "math_block":
      return (
        <View
          style={{
            marginVertical: props.compact ? 2 : 0,
            paddingHorizontal: props.node.type === "math_block" ? 10 : 0,
            paddingVertical: props.node.type === "math_block" ? 8 : 0,
            backgroundColor:
              props.node.type === "math_block"
                ? props.textStyle.codeBackgroundColor
                : "transparent",
          }}
        >
          <SelectableNode
            node={props.node}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
            highlight={highlight}
          />
        </View>
      );
    case "table_head":
    case "table_body":
    case "table_row":
    case "table_cell":
    case "list_item":
    case "task_list_item": {
      const children = props.node.children ?? [];
      const highlights = childHighlights(children);
      return (
        <View style={{ gap: 4 }}>
          {children.map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
              compact
              highlight={highlights[index]}
            />
          ))}
        </View>
      );
    }
    default:
      return (
        <SelectableNode
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
          highlight={highlight}
        />
      );
  }
}
