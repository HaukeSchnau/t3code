import { useMemo } from "react";
import { View } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  nativeMarkdownWithAuthoredWindowsPaths,
  nativeMarkdownWithPreservedSoftBreaks,
} from "./nativeMarkdownText";
import {
  distributeMarkdownHighlight,
  markdownRunsHighlightCount,
  type MarkdownTextHighlight,
} from "./markdownHighlight";
import {
  MarkdownImageRendererContext,
  markdownBlockHighlightCount,
  NativeMarkdownBlock,
} from "./NativeMarkdownBlock";
import {
  MarkdownContextClipboardContext,
  MarkdownFileContextMenuContext,
  NativeMarkdownSelectableText,
  type MarkdownFileContextMenuHandlers,
} from "./NativeMarkdownSelectableText";
import type {
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

const EMPTY_SKILLS: ReadonlyArray<SelectableMarkdownSkill> = [];

export type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

function markdownTextChunks(
  markdown: string,
  preserveSoftBreaks: boolean,
  skills: ReadonlyArray<SelectableMarkdownSkill>,
) {
  const parsedDocument = nativeMarkdownWithAuthoredWindowsPaths(
    parseMarkdownWithOptions(markdown, { gfm: true, html: true, math: false }),
    markdown,
  );
  const document = preserveSoftBreaks
    ? nativeMarkdownWithPreservedSoftBreaks(parsedDocument)
    : parsedDocument;
  return nativeMarkdownDocumentChunks(document).map((chunk) =>
    chunk.kind === "selectable"
      ? {
          ...chunk,
          runs: nativeMarkdownDocumentRuns(chunk.node, skills),
        }
      : chunk,
  );
}

type MarkdownTextChunk = ReturnType<typeof markdownTextChunks>[number];

function chunkHighlightCount(
  chunk: MarkdownTextChunk,
  skills: ReadonlyArray<SelectableMarkdownSkill>,
  find: MarkdownTextHighlight["find"],
): number {
  return "runs" in chunk
    ? markdownRunsHighlightCount(chunk.runs, find)
    : markdownBlockHighlightCount(chunk.node, skills, find);
}

/** How many ranges `find` marks when this markdown renders with the same options. */
export function countMarkdownHighlights(
  markdown: string,
  options: {
    readonly preserveSoftBreaks?: boolean | undefined;
    readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
  },
  find: MarkdownTextHighlight["find"],
): number {
  const skills = options.skills ?? EMPTY_SKILLS;
  return markdownTextChunks(markdown, options.preserveSoftBreaks ?? false, skills).reduce(
    (total, chunk) => total + chunkHighlightCount(chunk, skills, find),
    0,
  );
}

export function SelectableMarkdownText({
  markdown,
  contextClipboardFragment,
  skills = EMPTY_SKILLS,
  textStyle,
  highlightCode,
  preserveSoftBreaks = false,
  onLinkPress,
  fileContextMenu,
  onFileContextMenuAction,
  renderImage,
  marginTop = 0,
  marginBottom = 0,
  highlight,
}: SelectableMarkdownTextProps) {
  const chunks = useMemo(
    () => markdownTextChunks(markdown, preserveSoftBreaks, skills),
    [markdown, preserveSoftBreaks, skills],
  );
  const chunkHighlights = useMemo(
    () =>
      distributeMarkdownHighlight(highlight, chunks, (chunk) =>
        highlight ? chunkHighlightCount(chunk, skills, highlight.find) : 0,
      ),
    [chunks, highlight, skills],
  );

  const fileContextMenuHandlers = useMemo<MarkdownFileContextMenuHandlers | null>(
    () =>
      fileContextMenu && onFileContextMenuAction
        ? { fileContextMenu, onFileContextMenuAction }
        : null,
    [fileContextMenu, onFileContextMenuAction],
  );

  return (
    <MarkdownContextClipboardContext.Provider value={contextClipboardFragment ?? ""}>
      <MarkdownImageRendererContext.Provider value={renderImage ?? null}>
        <MarkdownFileContextMenuContext.Provider value={fileContextMenuHandlers}>
          {/* A percentage width here creates a cyclic intrinsic measurement inside
          shrink-to-fit containers such as user-message bubbles. Yoga then gives
          the native text node an unbounded second pass and the parent only clips
          the resulting single-line width instead of reflowing it. */}
          <View style={{ flexShrink: 1, minWidth: 0, marginTop, marginBottom }}>
            {chunks.map((chunk, index) => {
              const content =
                chunk.kind === "rich" ? (
                  <NativeMarkdownBlock
                    node={chunk.node}
                    skills={skills}
                    textStyle={textStyle}
                    highlightCode={highlightCode}
                    onLinkPress={onLinkPress}
                    highlight={chunkHighlights[index]}
                  />
                ) : (
                  <NativeMarkdownSelectableText
                    runs={chunk.runs}
                    textStyle={textStyle}
                    onLinkPress={onLinkPress}
                    highlight={chunkHighlights[index]}
                  />
                );

              return (
                <View
                  key={chunk.key}
                  style={{ paddingTop: nativeMarkdownChunkSpacing(chunks[index - 1], chunk) }}
                >
                  {content}
                </View>
              );
            })}
          </View>
        </MarkdownFileContextMenuContext.Provider>
      </MarkdownImageRendererContext.Provider>
    </MarkdownContextClipboardContext.Provider>
  );
}
