import { MessageId } from "@t3tools/contracts";
import { act } from "react";
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement, ReactNode } from "react";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
});

vi.mock("../ChatMarkdown", async () => {
  const React = await import("react");
  const MockChatMarkdown = React.memo(function MockChatMarkdown({
    renderBlock,
  }: {
    renderBlock?: (
      block: { readonly id: string; readonly kind: "paragraph" },
      element: ReactElement,
    ) => ReactNode;
  }) {
    /* eslint-disable react/no-unstable-nested-components -- This mock intentionally mirrors
     * ChatMarkdown's renderer-component lifecycle so a changed renderBlock identity remounts prose. */
    const Paragraph = React.useMemo(
      () =>
        function Paragraph() {
          const element = React.createElement("p", null, "A replyable paragraph.");
          return renderBlock?.({ id: "paragraph:0", kind: "paragraph" }, element) ?? element;
        },
      [renderBlock],
    );
    /* eslint-enable react/no-unstable-nested-components */
    return React.createElement(Paragraph);
  });
  return { default: MockChatMarkdown };
});

import { AssistantInlineReplies } from "./AssistantInlineReplies";
import { createInlineReplyDraftStore } from "./inlineReplies";

afterEach(() => vi.unstubAllGlobals());

describe("AssistantInlineReplies", () => {
  it("renders the transparent gutter target before the block is hovered", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const store = createInlineReplyDraftStore();
    let renderer: ReturnType<typeof TestRenderer.create>;
    await act(async () => {
      renderer = TestRenderer.create(
        <AssistantInlineReplies
          messageId={MessageId.make("assistant-1")}
          store={store}
          text="A replyable paragraph."
          cwd={undefined}
        />,
      );
    });

    const action = renderer!.root.findByProps({ "data-inline-reply-hover-affordance": true });
    expect(action.type).toBe("button");
    expect(action.props.className).toContain("opacity-0");
    expect(action.props.className).toContain("group-hover/inline-reply-block:opacity-100");
    await act(async () => renderer!.unmount());
  });

  it("keeps the reply textarea mounted while its draft changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const store = createInlineReplyDraftStore();
    const messageId = MessageId.make("assistant-1");
    const textareas: Array<{ style: Record<string, string>; scrollHeight: number }> = [];
    let replyId = "";

    let renderer: ReturnType<typeof TestRenderer.create>;
    await act(async () => {
      renderer = TestRenderer.create(
        <AssistantInlineReplies
          messageId={messageId}
          store={store}
          text="A replyable paragraph."
          cwd={undefined}
        />,
        {
          createNodeMock(element) {
            if (element.type !== "textarea") return null;
            const textarea = { style: {}, scrollHeight: 36 };
            textareas.push(textarea);
            return textarea;
          },
        },
      );
    });
    await act(async () => {
      replyId = store.add({
        messageId,
        blockId: "paragraph:0",
        anchorKind: "paragraph",
        quote: "A replyable paragraph.",
      });
    });

    expect(textareas).toHaveLength(1);

    await act(async () => store.update(replyId, "Still focused."));

    expect(textareas).toHaveLength(1);
    await act(async () => renderer!.unmount());
  });
});
