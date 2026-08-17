import { type MessageId } from "@t3tools/contracts";

export type InlineReplyAnchorKind = "paragraph" | "selection";

export interface InlineReplyTextRange {
  readonly start: number;
  readonly end: number;
}

export interface InlineReplyDraft {
  readonly id: string;
  readonly messageId: MessageId;
  readonly blockId: string;
  readonly anchorKind: InlineReplyAnchorKind;
  readonly quote: string;
  readonly textRange?: InlineReplyTextRange;
  readonly text: string;
}

type Listener = () => void;

export interface InlineReplyDraftStore {
  readonly highlightName: string;
  getAll: () => ReadonlyArray<InlineReplyDraft>;
  getForMessage: (messageId: MessageId) => ReadonlyArray<InlineReplyDraft>;
  getForBlock: (messageId: MessageId, blockId: string) => ReadonlyArray<InlineReplyDraft>;
  hasSendableContent: () => boolean;
  subscribe: (listener: Listener) => () => void;
  subscribeToMessage: (messageId: MessageId, listener: Listener) => () => void;
  subscribeToBlock: (messageId: MessageId, blockId: string, listener: Listener) => () => void;
  add: (input: Omit<InlineReplyDraft, "id" | "text">) => string;
  update: (replyId: string, text: string) => void;
  remove: (replyId: string) => void;
  clear: () => void;
  replaceAll: (replies: ReadonlyArray<InlineReplyDraft>) => void;
  setHighlightRanges: (messageId: MessageId, ranges: ReadonlyArray<Range>) => void;
  clearHighlightRanges: (messageId: MessageId) => void;
}

export function resolveInlineReplySelectionScope({
  selectedText,
  startBlockText,
  endsInStartBlock,
}: {
  readonly selectedText: string;
  readonly startBlockText: string;
  readonly endsInStartBlock: boolean;
}): "selection" | "whole-block" | null {
  if (endsInStartBlock) return "selection";
  return selectedText === startBlockText ? "whole-block" : null;
}

function authoredReplies(
  replies: ReadonlyArray<InlineReplyDraft>,
): ReadonlyArray<InlineReplyDraft> {
  return replies.filter((reply) => reply.text.trim().length > 0);
}

function markdownQuote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function formatInlineReplyPrompt(
  replies: ReadonlyArray<InlineReplyDraft>,
  overallNote: string,
): string {
  const replySections = authoredReplies(replies).map(
    (reply) => `${markdownQuote(reply.quote)}\n\n${reply.text.trim()}`,
  );
  const trimmedOverallNote = overallNote.trim();
  if (trimmedOverallNote.length > 0) replySections.push(trimmedOverallNote);
  return replySections.join("\n\n");
}

export function createInlineReplyDraftStore(): InlineReplyDraftStore {
  const highlightName = "inline-reply-anchor";
  let replies: ReadonlyArray<InlineReplyDraft> = [];
  let repliesByMessage = new Map<MessageId, ReadonlyArray<InlineReplyDraft>>();
  let repliesByBlock = new Map<MessageId, Map<string, ReadonlyArray<InlineReplyDraft>>>();
  let nextReplyId = 1;
  const listeners = new Set<Listener>();
  const messageListeners = new Map<MessageId, Set<Listener>>();
  const blockListeners = new Map<MessageId, Map<string, Set<Listener>>>();
  const highlightRangesByMessage = new Map<MessageId, ReadonlyArray<Range>>();

  const refreshHighlights = () => {
    if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") {
      return;
    }
    const ranges = [...highlightRangesByMessage.values()].flat();
    if (ranges.length === 0) {
      CSS.highlights.delete(highlightName);
      return;
    }
    CSS.highlights.set(highlightName, new Highlight(...ranges));
  };

  const notify = (
    messageIds: ReadonlySet<MessageId>,
    previousRepliesByBlock: ReadonlyMap<
      MessageId,
      ReadonlyMap<string, ReadonlyArray<InlineReplyDraft>>
    >,
  ) => {
    for (const listener of listeners) listener();
    for (const messageId of messageIds) {
      for (const listener of messageListeners.get(messageId) ?? []) listener();
      const previousBlocks = previousRepliesByBlock.get(messageId);
      const nextBlocks = repliesByBlock.get(messageId);
      const blockIds = new Set([...(previousBlocks?.keys() ?? []), ...(nextBlocks?.keys() ?? [])]);
      for (const blockId of blockIds) {
        const previousBlockReplies = previousBlocks?.get(blockId) ?? EMPTY_INLINE_REPLIES;
        const nextBlockReplies = nextBlocks?.get(blockId) ?? EMPTY_INLINE_REPLIES;
        if (previousBlockReplies === nextBlockReplies) continue;
        for (const listener of blockListeners.get(messageId)?.get(blockId) ?? []) listener();
      }
    }
  };

  const replaceReplies = (
    nextReplies: ReadonlyArray<InlineReplyDraft>,
    affectedMessageIds: ReadonlySet<MessageId>,
  ) => {
    if (nextReplies === replies) return;
    const previousRepliesByBlock = repliesByBlock;
    replies = nextReplies;
    const nextRepliesByMessage = new Map<MessageId, InlineReplyDraft[]>();
    const nextRepliesByBlock = new Map<MessageId, Map<string, InlineReplyDraft[]>>();
    for (const reply of replies) {
      const messageReplies = nextRepliesByMessage.get(reply.messageId) ?? [];
      messageReplies.push(reply);
      nextRepliesByMessage.set(reply.messageId, messageReplies);
      const messageBlocks = nextRepliesByBlock.get(reply.messageId) ?? new Map();
      const blockReplies = messageBlocks.get(reply.blockId) ?? [];
      blockReplies.push(reply);
      messageBlocks.set(reply.blockId, blockReplies);
      nextRepliesByBlock.set(reply.messageId, messageBlocks);
    }
    repliesByMessage = nextRepliesByMessage;
    repliesByBlock = new Map(
      [...nextRepliesByBlock].map(([messageId, messageBlocks]) => [
        messageId,
        new Map(
          [...messageBlocks].map(([blockId, blockReplies]) => {
            const previous = previousRepliesByBlock.get(messageId)?.get(blockId);
            const unchanged =
              previous?.length === blockReplies.length &&
              previous.every((reply, index) => reply === blockReplies[index]);
            return [blockId, unchanged ? previous : blockReplies];
          }),
        ),
      ]),
    );
    notify(affectedMessageIds, previousRepliesByBlock);
  };

  return {
    highlightName,
    getAll: () => replies,
    getForMessage: (messageId) => repliesByMessage.get(messageId) ?? EMPTY_INLINE_REPLIES,
    getForBlock: (messageId, blockId) =>
      repliesByBlock.get(messageId)?.get(blockId) ?? EMPTY_INLINE_REPLIES,
    hasSendableContent: () => authoredReplies(replies).length > 0,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeToMessage: (messageId, listener) => {
      const existing = messageListeners.get(messageId);
      const messageSet = existing ?? new Set<Listener>();
      if (!existing) messageListeners.set(messageId, messageSet);
      messageSet.add(listener);
      return () => {
        messageSet.delete(listener);
        if (messageSet.size === 0) messageListeners.delete(messageId);
      };
    },
    subscribeToBlock: (messageId, blockId, listener) => {
      const messageBlocks = blockListeners.get(messageId) ?? new Map<string, Set<Listener>>();
      if (!blockListeners.has(messageId)) blockListeners.set(messageId, messageBlocks);
      const blockSet = messageBlocks.get(blockId) ?? new Set<Listener>();
      if (!messageBlocks.has(blockId)) messageBlocks.set(blockId, blockSet);
      blockSet.add(listener);
      return () => {
        blockSet.delete(listener);
        if (blockSet.size === 0) messageBlocks.delete(blockId);
        if (messageBlocks.size === 0) blockListeners.delete(messageId);
      };
    },
    add: (input) => {
      const existing = replies.find(
        (reply) =>
          reply.messageId === input.messageId &&
          reply.blockId === input.blockId &&
          reply.anchorKind === input.anchorKind &&
          (input.anchorKind === "paragraph" || reply.quote === input.quote),
      );
      if (existing) return existing.id;

      const id = `inline-reply-${nextReplyId++}`;
      replaceReplies([...replies, { ...input, id, text: "" }], new Set([input.messageId]));
      return id;
    },
    update: (replyId, text) => {
      const reply = replies.find((candidate) => candidate.id === replyId);
      if (!reply || reply.text === text) return;
      replaceReplies(
        replies.map((candidate) => (candidate.id === replyId ? { ...candidate, text } : candidate)),
        new Set([reply.messageId]),
      );
    },
    remove: (replyId) => {
      const reply = replies.find((candidate) => candidate.id === replyId);
      if (!reply) return;
      replaceReplies(
        replies.filter((candidate) => candidate.id !== replyId),
        new Set([reply.messageId]),
      );
    },
    clear: () => {
      if (replies.length === 0) return;
      const messageIds = new Set(replies.map((reply) => reply.messageId));
      replaceReplies([], messageIds);
      highlightRangesByMessage.clear();
      refreshHighlights();
    },
    replaceAll: (nextReplies) => {
      const messageIds = new Set([
        ...replies.map((reply) => reply.messageId),
        ...nextReplies.map((reply) => reply.messageId),
      ]);
      replaceReplies([...nextReplies], messageIds);
    },
    setHighlightRanges: (messageId, ranges) => {
      highlightRangesByMessage.set(messageId, ranges);
      refreshHighlights();
    },
    clearHighlightRanges: (messageId) => {
      if (!highlightRangesByMessage.delete(messageId)) return;
      refreshHighlights();
    },
  };
}

const EMPTY_INLINE_REPLIES: ReadonlyArray<InlineReplyDraft> = [];
