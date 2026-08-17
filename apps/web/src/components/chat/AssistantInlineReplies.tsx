import { type MessageId } from "@t3tools/contracts";
import { CornerDownLeftIcon, XIcon } from "lucide-react";
import {
  cloneElement,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import ChatMarkdown, {
  type ChatMarkdownBlockRenderer,
  type ChatMarkdownProps,
} from "../ChatMarkdown";
import { cn } from "../../lib/utils";
import {
  resolveInlineReplySelectionScope,
  type InlineReplyDraft,
  type InlineReplyDraftStore,
} from "./inlineReplies";

interface SelectionAction {
  readonly blockId: string;
  readonly quote: string;
  readonly textRange: { readonly start: number; readonly end: number };
  readonly left: number;
  readonly top: number;
}

interface HoveredBlockAction {
  readonly blockId: string;
  readonly left: number;
  readonly top: number;
}

interface AssistantInlineRepliesProps extends ChatMarkdownProps {
  readonly messageId: MessageId;
  readonly store: InlineReplyDraftStore;
}

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [reply.text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    store.remove(reply.id);
  };

  return (
    <div data-inline-reply-ui className="group/inline-editor relative mt-1.5 ml-2">
      <div className="relative rounded-md border border-border/65 focus-within:border-foreground/25">
        <span className="absolute -top-2 left-2.5 max-w-[calc(100%-2.75rem)] truncate bg-background px-1 text-[10px] leading-4 text-muted-foreground">
          {reply.anchorKind === "paragraph" ? "Whole paragraph" : `“${reply.quote}”`}
        </span>
        <textarea
          ref={textareaRef}
          data-inline-reply-id={reply.id}
          rows={1}
          value={reply.text}
          aria-label={`Reply to ${reply.anchorKind === "paragraph" ? "paragraph" : "selection"}`}
          placeholder="Reply…"
          className="block min-h-9 max-h-40 w-full resize-none overflow-y-auto bg-transparent px-2.5 py-2 pr-8 text-sm leading-5 outline-none placeholder:text-muted-foreground/60"
          onChange={(event) => store.update(reply.id, event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          aria-label="Remove inline reply"
          className="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/inline-editor:opacity-100"
          onClick={() => store.remove(reply.id)}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function AssistantInlineReplies({
  messageId,
  store,
  isStreaming = false,
  ...markdownProps
}: AssistantInlineRepliesProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [selectionAction, setSelectionAction] = useState<SelectionAction | null>(null);
  const [hoveredBlockAction, setHoveredBlockAction] = useState<HoveredBlockAction | null>(null);
  const replies = useSyncExternalStore(
    useCallback((listener) => store.subscribeToMessage(messageId, listener), [messageId, store]),
    useCallback(() => store.getForMessage(messageId), [messageId, store]),
    useCallback(() => store.getForMessage(messageId), [messageId, store]),
  );

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

  useEffect(() => {
    if (!selectionAction && !hoveredBlockAction) return;
    const dismissOnScroll = () => {
      setSelectionAction(null);
      setHoveredBlockAction(null);
    };
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => window.removeEventListener("scroll", dismissOnScroll, true);
  }, [hoveredBlockAction, selectionAction]);

  const addParagraphReply = useCallback(
    (blockId: string) => {
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
      setHoveredBlockAction(null);
      focusReplyEditor(replyId);
    },
    [messageId, store],
  );

  const renderBlock = useCallback<ChatMarkdownBlockRenderer>(
    (block, element) => {
      const blockReplies = replies.filter((reply) => reply.blockId === block.id);
      const hasParagraphReply = blockReplies.some((reply) => reply.anchorKind === "paragraph");
      const htmlElement = element as ReactElement<React.HTMLAttributes<HTMLElement>>;
      const decoratedElement = cloneElement(
        htmlElement,
        {
          ...htmlElement.props,
          className: cn(htmlElement.props.className, "group/inline-reply-block relative"),
          "data-inline-reply-block-id": block.id,
          "data-inline-reply-block-kind": block.kind,
        } as React.HTMLAttributes<HTMLElement>,
        htmlElement.props.children,
        hasParagraphReply ? (
          <span
            key="reply-indicator"
            data-inline-reply-ui
            aria-hidden="true"
            className="absolute top-[0.65rem] -left-3 size-1 rounded-full bg-primary/60"
          />
        ) : null,
        block.kind === "list-item"
          ? blockReplies.map((reply) => (
              <InlineReplyEditor key={reply.id} reply={reply} store={store} />
            ))
          : null,
      );

      if (block.kind === "list-item") return decoratedElement;
      return (
        <Fragment key={block.id}>
          {decoratedElement}
          {blockReplies.map((reply) => (
            <InlineReplyEditor key={reply.id} reply={reply} store={store} />
          ))}
        </Fragment>
      );
    },
    [replies, store],
  );

  const updateHoveredBlock = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const target = event.target;
    if (!root || !(target instanceof Node)) return;
    if (target instanceof Element && target.closest("[data-inline-reply-hover-affordance]")) {
      return;
    }
    if (target instanceof Element && target.closest("[data-inline-reply-ui]")) {
      setHoveredBlockAction(null);
      return;
    }
    const block = sourceBlockForNode(target, root);
    const blockId = block?.dataset.inlineReplyBlockId;
    if (!block || !blockId) {
      setHoveredBlockAction(null);
      return;
    }
    const bounds = block.getBoundingClientRect();
    const left =
      bounds.right + 28 <= window.innerWidth ? bounds.right : Math.max(8, bounds.right - 28);
    const next = { blockId, left, top: Math.max(8, bounds.top) };
    setHoveredBlockAction((current) =>
      current?.blockId === next.blockId && current.left === next.left && current.top === next.top
        ? current
        : next,
    );
  }, []);

  const dismissHoveredBlock = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Element &&
      nextTarget.closest("[data-inline-reply-hover-affordance]")
    ) {
      return;
    }
    setHoveredBlockAction(null);
  }, []);

  const updateSelectionAction = useCallback(() => {
    if (isStreaming) return;
    const root = rootRef.current;
    const selection = window.getSelection();
    const quote = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      quote.length < 2
    ) {
      setSelectionAction(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const startBlock = sourceBlockForNode(range.startContainer, root);
    const endBlock = sourceBlockForNode(range.endContainer, root);
    const blockId = startBlock?.dataset.inlineReplyBlockId;
    if (!startBlock || !blockId) {
      setSelectionAction(null);
      return;
    }

    const scope = resolveInlineReplySelectionScope({
      selectedText: quote,
      startBlockText: normalizedBlockText(startBlock),
      endsInStartBlock: startBlock === endBlock,
    });
    if (!scope) {
      setSelectionAction(null);
      return;
    }

    const effectiveRange =
      scope === "whole-block"
        ? restoreTextRange(startBlock, {
            start: 0,
            end: selectableBlockTextLength(startBlock),
          })
        : range;
    if (!effectiveRange) {
      setSelectionAction(null);
      return;
    }

    const precedingRange = document.createRange();
    precedingRange.selectNodeContents(startBlock);
    precedingRange.setEnd(effectiveRange.startContainer, effectiveRange.startOffset);
    const start = precedingRange.toString().length;
    const bounds = effectiveRange.getBoundingClientRect();
    const selectedRangeText = effectiveRange.toString();
    setSelectionAction({
      blockId,
      quote: selectedRangeText.replace(/\s+/g, " ").trim(),
      textRange: { start, end: start + selectedRangeText.length },
      left: Math.min(window.innerWidth - 144, Math.max(12, bounds.left + bounds.width / 2 - 66)),
      top: Math.max(12, bounds.top - 38),
    });
  }, [isStreaming]);

  useEffect(() => {
    document.addEventListener("selectionchange", updateSelectionAction);
    return () => document.removeEventListener("selectionchange", updateSelectionAction);
  }, [updateSelectionAction]);

  const addSelectionReply = useCallback(() => {
    if (!selectionAction) return;
    const replyId = store.add({
      messageId,
      blockId: selectionAction.blockId,
      anchorKind: "selection",
      quote: selectionAction.quote,
      textRange: selectionAction.textRange,
    });
    setSelectionAction(null);
    window.getSelection()?.removeAllRanges();
    focusReplyEditor(replyId);
  }, [messageId, selectionAction, store]);

  if (isStreaming) return <ChatMarkdown {...markdownProps} isStreaming />;

  return (
    <div
      ref={rootRef}
      onMouseMove={updateHoveredBlock}
      onMouseLeave={dismissHoveredBlock}
      onMouseUp={updateSelectionAction}
      onKeyUp={updateSelectionAction}
    >
      <ChatMarkdown {...markdownProps} renderBlock={renderBlock} />
      {hoveredBlockAction && !selectionAction && typeof document !== "undefined"
        ? createPortal(
            <button
              type="button"
              data-inline-reply-ui
              data-inline-reply-hover-affordance
              aria-label="Reply to this paragraph"
              className="fixed z-40 flex h-6 w-7 items-center pl-1 max-sm:hidden"
              style={{ left: hoveredBlockAction.left, top: hoveredBlockAction.top }}
              onMouseLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return;
                setHoveredBlockAction(null);
              }}
              onClick={() => addParagraphReply(hoveredBlockAction.blockId)}
            >
              <span className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                <CornerDownLeftIcon className="size-3.5" />
              </span>
            </button>,
            document.body,
          )
        : null}
      {selectionAction && typeof document !== "undefined"
        ? createPortal(
            <button
              type="button"
              data-inline-reply-ui
              className="fixed z-50 flex items-center gap-1.5 rounded-full bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg"
              style={{ left: selectionAction.left, top: selectionAction.top }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={addSelectionReply}
            >
              <CornerDownLeftIcon className="size-3.5" />
              Reply
            </button>,
            document.body,
          )
        : null}
    </div>
  );
}
