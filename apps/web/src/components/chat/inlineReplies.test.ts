import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createInlineReplyDraftStore,
  formatInlineReplyPrompt,
  resolveInlineReplySelectionScope,
} from "./inlineReplies";

describe("inline replies", () => {
  it("restores persisted replies and continues emitting draft changes", () => {
    const messageId = MessageId.make("assistant-1");
    const onChange = vi.fn();
    const store = createInlineReplyDraftStore({
      initialReplies: [
        {
          id: "inline-reply-1",
          messageId,
          blockId: "paragraph:0",
          anchorKind: "paragraph",
          quote: "The first paragraph.",
          text: "Keep this reply while navigating.",
        },
      ],
      onChange,
    });

    expect(store.getAll()).toHaveLength(1);
    expect(store.getForBlock(messageId, "paragraph:0")[0]?.text).toBe(
      "Keep this reply while navigating.",
    );
    expect(onChange).not.toHaveBeenCalled();

    const nextId = store.add({
      messageId,
      blockId: "paragraph:1",
      anchorKind: "paragraph",
      quote: "The second paragraph.",
    });

    expect(nextId).toBe("inline-reply-2");
    expect(onChange).toHaveBeenLastCalledWith(store.getAll());
  });

  it("accepts word and browser-native whole-paragraph selections", () => {
    expect(
      resolveInlineReplySelectionScope({
        selectedText: "marketplace",
        startBlockText: "Pin the marketplace to the audited commit.",
        endsInStartBlock: true,
      }),
    ).toBe("selection");
    expect(
      resolveInlineReplySelectionScope({
        selectedText: "Pin the marketplace to the audited commit.",
        startBlockText: "Pin the marketplace to the audited commit.",
        endsInStartBlock: false,
      }),
    ).toBe("whole-block");
  });

  it("rejects a selection containing text from multiple blocks", () => {
    expect(
      resolveInlineReplySelectionScope({
        selectedText: "First paragraph. Second paragraph.",
        startBlockText: "First paragraph.",
        endsInStartBlock: false,
      }),
    ).toBeNull();
  });

  it("formats authored replies and an overall note as one ordinary prompt", () => {
    const store = createInlineReplyDraftStore();
    const messageId = MessageId.make("assistant-1");
    const firstId = store.add({
      messageId,
      blockId: "paragraph:0",
      anchorKind: "selection",
      quote: "Pin the marketplace",
      textRange: { start: 0, end: 19 },
    });
    const secondId = store.add({
      messageId,
      blockId: "list-item:42",
      anchorKind: "paragraph",
      quote: "Add a global compatibility rule.",
    });
    store.update(firstId, "I am fine with it moving automatically.");
    store.update(secondId, "Please make this change.");

    expect(formatInlineReplyPrompt(store.getAll(), "Everything else looks good.")).toBe(
      [
        "> Pin the marketplace",
        "",
        "I am fine with it moving automatically.",
        "",
        "> Add a global compatibility rule.",
        "",
        "Please make this change.",
        "",
        "Everything else looks good.",
      ].join("\n"),
    );
  });

  it("ignores empty editors and deduplicates a paragraph reply", () => {
    const store = createInlineReplyDraftStore();
    const messageId = MessageId.make("assistant-1");
    const input = {
      messageId,
      blockId: "paragraph:0",
      anchorKind: "paragraph" as const,
      quote: "The paragraph.",
    };

    expect(store.add(input)).toBe(store.add(input));
    expect(store.getAll()).toHaveLength(1);
    expect(store.hasSendableContent()).toBe(false);
    expect(formatInlineReplyPrompt(store.getAll(), "An overall note.")).toBe("An overall note.");
  });

  it("notifies only the affected message subscribers", () => {
    const store = createInlineReplyDraftStore();
    const firstMessageId = MessageId.make("assistant-1");
    const secondMessageId = MessageId.make("assistant-2");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    store.subscribeToMessage(firstMessageId, firstListener);
    store.subscribeToMessage(secondMessageId, secondListener);

    const replyId = store.add({
      messageId: firstMessageId,
      blockId: "paragraph:0",
      anchorKind: "paragraph",
      quote: "The paragraph.",
    });
    store.update(replyId, "A reply.");

    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).not.toHaveBeenCalled();
  });

  it("keeps unrelated block snapshots and subscribers stable while typing", () => {
    const store = createInlineReplyDraftStore();
    const messageId = MessageId.make("assistant-1");
    const firstBlockListener = vi.fn();
    const secondBlockListener = vi.fn();
    store.subscribeToBlock(messageId, "paragraph:0", firstBlockListener);
    store.subscribeToBlock(messageId, "paragraph:42", secondBlockListener);

    const firstReplyId = store.add({
      messageId,
      blockId: "paragraph:0",
      anchorKind: "paragraph",
      quote: "First paragraph.",
    });
    store.add({
      messageId,
      blockId: "paragraph:42",
      anchorKind: "paragraph",
      quote: "Second paragraph.",
    });
    const secondBlockSnapshot = store.getForBlock(messageId, "paragraph:42");
    firstBlockListener.mockClear();
    secondBlockListener.mockClear();

    store.update(firstReplyId, "Typing must not replace the other block.");

    expect(firstBlockListener).toHaveBeenCalledOnce();
    expect(secondBlockListener).not.toHaveBeenCalled();
    expect(store.getForBlock(messageId, "paragraph:42")).toBe(secondBlockSnapshot);
  });
});
