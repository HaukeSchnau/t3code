import { EnvironmentId, MessageId, ThreadId, type FollowUpOrigin } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { captureOriginFromParams, followUpCaptureInput } from "./followUpCapture";

const origin: FollowUpOrigin = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  quote: "Retry the upload once the M1 is back\nIt failed twice tonight.",
  threadTitle: "Upload flakes",
};

describe("captureOriginFromParams", () => {
  it("reads a quote and ignores params that cannot name one", () => {
    expect(
      captureOriginFromParams({
        environmentId: "env-1",
        threadId: "thread-1",
        quote: "  some text \n",
        threadTitle: " ",
      }),
    ).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
      messageId: null,
      quote: "some text",
      threadTitle: null,
    });
    for (const params of [
      undefined,
      {},
      { environmentId: "env-1", threadId: "thread-1" },
      { environmentId: "env-1", threadId: "thread-1", quote: "   " },
      { threadId: "thread-1", quote: "text" },
      { environmentId: " ", threadId: "thread-1", quote: "text" },
    ]) {
      expect(captureOriginFromParams(params)).toBe(null);
    }
  });
});

describe("followUpCaptureInput", () => {
  it("saves nothing until there is a note or a quote", () => {
    expect(followUpCaptureInput("  \n ", null)).toBe(null);
    expect(followUpCaptureInput("Call the bank\nabout the card", null)).toEqual({
      title: "Call the bank",
      body: "Call the bank\nabout the card",
    });
    // A long one-line note keeps all its words in the body once the title shortens it.
    const long = `Renew the Hamburg FritzBox certificate before it expires, ${"and check the tower wake ".repeat(3)}`;
    expect(followUpCaptureInput(long, null)?.body).toBe(long.trim());
  });

  it("names a quote by its first line until the user titles it", () => {
    expect(followUpCaptureInput("", origin)).toEqual({
      title: "Retry the upload once the M1 is back",
      body: "",
      origin,
    });
    expect(followUpCaptureInput("Fix the uploader", origin)).toEqual({
      title: "Fix the uploader",
      body: "",
      origin,
    });
  });
});
