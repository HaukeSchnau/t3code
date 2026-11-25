import { type MessageId } from "@t3tools/contracts";
import { CornerDownLeftIcon, XIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import {
  cloneElement,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import ChatMarkdown, {
  type ChatMarkdownBlockRenderer,
  type ChatMarkdownBlock,
  type ChatMarkdownProps,
} from "../ChatMarkdown";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import {
  resolveInlineReplySelectionScope,
  type InlineReplyDraft,
  type InlineReplyDraftStore,
} from "./inlineReplies";

interface AssistantInlineRepliesProps extends ChatMarkdownProps {
  readonly messageId: MessageId;
  readonly store: InlineReplyDraftStore;
}

// The selection toolbar reaches a message's replies through the root its markdown renders in.
const inlineReplyRoots = new WeakMap<
  HTMLElement,
  { readonly messageId: MessageId; readonly store: InlineReplyDraftStore }
>();

function sourceBlockForNode(node: Node | null, root: HTMLElement): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  if (!element || !root.contains(element)) return null;
  const listItem = element.closest<HTMLElement>('[data-inline-reply-block-kind="list-item"]');
  if (listItem && root.contains(listItem)) return listItem;
  const paragraph = element.closest<HTMLElement>('[data-inline-reply-block-kind="paragraph"]');
  return paragraph && root.contains(paragraph) ? paragraph : null;
}

function normalizedBlockText(block: HTMLElement): string {
  const copy = block.cloneNode(true) as HTMLElement;
  for (const replyUi of copy.querySelectorAll("[data-inline-reply-ui]")) replyUi.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function selectableBlockTextLength(root: HTMLElement): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let length = 0;
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (!textNode.parentElement?.closest("[data-inline-reply-ui]")) {
      length += textNode.data.length;
    }
    node = walker.nextNode();
  }
  return length;
}

function restoreTextRange(
  root: HTMLElement,
  offsets: { start: number; end: number },
): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let node = walker.nextNode();

  while (node) {
    const textNode = node as Text;
    if (textNode.parentElement?.closest("[data-inline-reply-ui]")) {
      node = walker.nextNode();
      continue;
    }
    const nextConsumed = consumed + textNode.data.length;
    if (!startNode && offsets.start <= nextConsumed) {
      startNode = textNode;
      startOffset = Math.max(0, offsets.start - consumed);
    }
    if (startNode && offsets.end <= nextConsumed) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(textNode, Math.max(0, offsets.end - consumed));
      return range;
    }
    consumed = nextConsumed;
    node = walker.nextNode();
  }

  return null;
}

function focusReplyEditor(replyId: string) {
  requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>(`[data-inline-reply-id="${replyId}"]`)?.focus();
  });
}

function InlineReplyEditor({
  reply,
  store,
}: {
  reply: InlineReplyDraft;
  store: InlineReplyDraftStore;
}) {
  const gt = useGT();

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    store.remove(reply.id);
  };

  return (
    <div
      data-inline-reply-ui
      data-thread-find-ignore
      className="group/inline-editor mt-1.5 ml-2 flex flex-col gap-1"
    >
      <Text variant="caption" tone="muted" truncate>
        {reply.anchorKind === "paragraph" ? gt("Whole paragraph") : `“${reply.quote}”`}
      </Text>
      <div className="flex items-start gap-1">
        <Textarea
          size="sm"
          rows={1}
          className="min-w-0 flex-1"
          data-inline-reply-id={reply.id}
          value={reply.text}
          aria-label={
            reply.anchorKind === "paragraph" ? gt("Reply to paragraph") : gt("Reply to selection")
          }
          placeholder={gt("Reply…")}
          onChange={(event) => store.update(reply.id, event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="opacity-0 focus-within:opacity-100 group-hover/inline-editor:opacity-100 pointer-coarse:opacity-100">
          <Button
            variant="ghost-muted"
            size="icon-fixed-xs"
            aria-label={gt("Remove inline reply")}
            onClick={() => store.remove(reply.id)}
          >
            <XIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

function InlineReplyBlock({
  messageId,
  block,
  element,
  store,
  onParagraphReply,
}: {
  messageId: MessageId;
  block: ChatMarkdownBlock;
  element: ReactElement;
  store: InlineReplyDraftStore;
  onParagraphReply: (blockId: string) => void;
}) {
  const gt = useGT();
  const getReplies = () => store.getForBlock(messageId, block.id);
  const replies = useSyncExternalStore(
    (listener) => store.subscribeToBlock(messageId, block.id, listener),
    getReplies,
    getReplies,
  );
  const hasParagraphReply = replies.some((reply) => reply.anchorKind === "paragraph");
  const htmlElement = element as ReactElement<React.HTMLAttributes<HTMLElement>>;
  const decoratedElement = cloneElement(
    htmlElement,
    {
      className: cn(
        htmlElement.props.className,
        "group/inline-reply-block relative",
        block.kind === "list-item" &&
          "[&_[data-inline-reply-block-kind=paragraph]_[data-inline-reply-hover-affordance]]:hidden",
      ),
      "data-inline-reply-block-id": block.id,
      "data-inline-reply-block-kind": block.kind,
    } as React.HTMLAttributes<HTMLElement>,
    htmlElement.props.children,
    hasParagraphReply ? (
      <span
        key="reply-indicator"
        data-inline-reply-ui
        data-thread-find-ignore
        aria-hidden="true"
        className="absolute top-[0.65rem] -left-3 size-1 rounded-full bg-primary"
      />
    ) : null,
    <span
      key="reply-action"
      data-inline-reply-ui
      data-thread-find-ignore
      data-inline-reply-hover-affordance
      className="absolute top-0 left-full z-10 flex h-6 w-7 justify-end opacity-0 group-hover/inline-reply-block:opacity-100 hover:opacity-100 focus-within:opacity-100 max-sm:hidden"
    >
      <Button
        variant="ghost-muted"
        size="icon-fixed-xs"
        aria-label={gt("Reply to this paragraph")}
        onClick={() => onParagraphReply(block.id)}
      >
        <CornerDownLeftIcon />
      </Button>
    </span>,
    block.kind === "list-item"
      ? replies.map((reply) => <InlineReplyEditor key={reply.id} reply={reply} store={store} />)
      : null,
  );

  if (block.kind === "list-item") return decoratedElement;
  return (
    <>
      {decoratedElement}
      {replies.map((reply) => (
        <InlineReplyEditor key={reply.id} reply={reply} store={store} />
      ))}
    </>
  );
}

/** The reply a selection in a replyable message would start, or null when it can take none. */
function selectionReplyFor(range: Range) {
  const node = range.startContainer;
  const root = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>(
    "[data-inline-reply-root]",
  );
  const target = root ? inlineReplyRoots.get(root) : undefined;
  const quote = range.toString().replace(/\s+/g, " ").trim();
  if (!root || !target || quote.length < 2) return null;

  const startBlock = sourceBlockForNode(range.startContainer, root);
  const endBlock = sourceBlockForNode(range.endContainer, root);
  const blockId = startBlock?.dataset.inlineReplyBlockId;
  if (!startBlock || !blockId) return null;
  const scope = resolveInlineReplySelectionScope({
    selectedText: quote,
    startBlockText: normalizedBlockText(startBlock),
    endsInStartBlock: startBlock === endBlock,
  });
  if (!scope) return null;
  const effectiveRange =
    scope === "whole-block"
      ? restoreTextRange(startBlock, { start: 0, end: selectableBlockTextLength(startBlock) })
      : range;
  if (!effectiveRange) return null;

  const precedingRange = document.createRange();
  precedingRange.selectNodeContents(startBlock);
  precedingRange.setEnd(effectiveRange.startContainer, effectiveRange.startOffset);
  const start = precedingRange.toString().length;
  const selectedText = effectiveRange.toString();
  return {
    ...target,
    blockId,
    quote: selectedText.replace(/\s+/g, " ").trim(),
    textRange: { start, end: start + selectedText.length },
  };
}

/** Reply in the selection toolbar, for a selection inside one block of a replyable message. */
export function InlineSelectionReplyButton({
  range,
  onDone,
}: {
  range: Range;
  onDone: () => void;
}) {
  const reply = selectionReplyFor(range);
  if (!reply) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() => {
        const replyId = reply.store.add({
          messageId: reply.messageId,
          blockId: reply.blockId,
          anchorKind: "selection",
          quote: reply.quote,
          textRange: reply.textRange,
        });
        window.getSelection()?.removeAllRanges();
        onDone();
        focusReplyEditor(replyId);
      }}
    >
      <CornerDownLeftIcon aria-hidden="true" />
      <T context="verb">Reply</T>
    </Button>
  );
}

export function AssistantInlineReplies({
  messageId,
  store,
  isStreaming = false,
  ...markdownProps
}: AssistantInlineRepliesProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const getReplies = () => store.getForMessage(messageId);
  const replies = useSyncExternalStore(
    (listener) => store.subscribeToMessage(messageId, listener),
    getReplies,
    getReplies,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Highlight ranges are DOM ranges over the rendered markdown.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ranges = replies.flatMap((reply) => {
      if (reply.anchorKind !== "selection" || !reply.textRange) return [];
      const block = root.querySelector<HTMLElement>(
        `[data-inline-reply-block-id="${reply.blockId}"]`,
      );
      const range = block ? restoreTextRange(block, reply.textRange) : null;
      return range ? [range] : [];
    });
    store.setHighlightRanges(messageId, ranges);
    return () => store.clearHighlightRanges(messageId);
  }, [messageId, replies, store]);

  const addParagraphReply = (blockId: string) => {
    const blockElement = rootRef.current?.querySelector<HTMLElement>(
      `[data-inline-reply-block-id="${blockId}"]`,
    );
    if (!blockElement) return;
    const quote = normalizedBlockText(blockElement);
    if (!quote) return;
    const replyId = store.add({
      messageId,
      blockId,
      anchorKind: "paragraph",
      quote,
    });
    focusReplyEditor(replyId);
  };

  const renderBlock: ChatMarkdownBlockRenderer = (block, element) => (
    <InlineReplyBlock
      key={block.id}
      messageId={messageId}
      block={block}
      element={element}
      store={store}
      onParagraphReply={addParagraphReply}
    />
  );

  const attachRoot = (root: HTMLDivElement | null) => {
    rootRef.current = root;
    if (root) inlineReplyRoots.set(root, { messageId, store });
  };

  if (isStreaming) return <ChatMarkdown {...markdownProps} isStreaming />;

  return (
    <div ref={attachRoot} data-inline-reply-root>
      <ChatMarkdown {...markdownProps} renderBlock={renderBlock} />
    </div>
  );
}
