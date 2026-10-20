import { MessageId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChatMarkdownBlockRenderer, ChatMarkdownProps } from "../ChatMarkdown";

// Builds the paragraph component per renderBlock identity, so a renderBlock that changed on every
// render would remount the prose and the reply textarea with it.
vi.mock(import("../ChatMarkdown"), async (importOriginal) => {
  const paragraphs = new WeakMap<ChatMarkdownBlockRenderer, () => ReactNode>();
  const paragraphFor = (renderBlock: ChatMarkdownBlockRenderer) => {
    const existing = paragraphs.get(renderBlock);
    if (existing) return existing;
    const Paragraph = () =>
      renderBlock({ id: "paragraph:0", kind: "paragraph" }, <p>A replyable paragraph.</p>);
    paragraphs.set(renderBlock, Paragraph);
    return Paragraph;
  };
  return {
    ...(await importOriginal()),
    default: (({ renderBlock }: ChatMarkdownProps) => {
      if (!renderBlock) return <p>A replyable paragraph.</p>;
      const Paragraph = paragraphFor(renderBlock);
      return <Paragraph />;
    }) as never,
  };
});

import { AssistantInlineReplies } from "./AssistantInlineReplies";
import { createInlineReplyDraftStore } from "./inlineReplies";

const TEXT = "A replyable paragraph.";
const messageId = MessageId.make("assistant-1");

async function mount(store: ReturnType<typeof createInlineReplyDraftStore>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <AssistantInlineReplies messageId={messageId} store={store} text={TEXT} cwd={undefined} />,
    ),
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("AssistantInlineReplies", () => {
  it("renders the transparent gutter target before the block is hovered", async () => {
    const view = await mount(createInlineReplyDraftStore());
    try {
      const action = view.container.querySelector("[data-inline-reply-hover-affordance]");
      expect(action?.tagName).toBe("BUTTON");
      expect(action?.className).toContain("opacity-0");
      expect(action?.className).toContain("group-hover/inline-reply-block:opacity-100");
    } finally {
      await view.unmount();
    }
  });

  it("keeps the reply textarea mounted while its draft changes", async () => {
    const store = createInlineReplyDraftStore();
    const view = await mount(store);
    try {
      let replyId = "";
      await act(async () => {
        replyId = store.add({
          messageId,
          blockId: "paragraph:0",
          anchorKind: "paragraph",
          quote: TEXT,
        });
      });
      const textarea = view.container.querySelector("textarea");
      expect(textarea).not.toBeNull();

      await act(async () => store.update(replyId, "Still focused."));

      expect(view.container.querySelectorAll("textarea")).toHaveLength(1);
      expect(view.container.querySelector("textarea")).toBe(textarea);
    } finally {
      await view.unmount();
    }
  });
});
