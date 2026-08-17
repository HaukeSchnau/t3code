import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createInlineReplyDraftStore,
  formatInlineReplyPrompt,
  resolveInlineReplySelectionScope,
} from "./inlineReplies";

describe("inline replies", () => {
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
});
