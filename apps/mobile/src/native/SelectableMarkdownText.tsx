import type {
  countMarkdownHighlights as countRenderedMarkdownHighlights,
  SelectableMarkdownTextProps,
} from "@t3tools/mobile-markdown-text/renderer";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  MarkdownFileContextMenu,
  MarkdownFileContextMenuAction,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@t3tools/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return false;
}

export const countMarkdownHighlights: typeof countRenderedMarkdownHighlights = () => 0;

export function SelectableMarkdownText(_props: MobileSelectableMarkdownTextProps) {
  return null;
}
