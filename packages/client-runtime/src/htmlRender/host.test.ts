import type { HtmlRenderCallToolResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type HtmlRenderBridgeTarget, makeHtmlRenderHost } from "./host.ts";

const active = { active: true };
const idle = { active: false };
const click = { jsonrpc: "2.0", method: "t3/notifications/activated" };
const send = (id: string, text: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "t3/send",
  params: { text },
});
const callTool = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "t3/call-tool",
  params: { name, arguments: args },
});

function setup(
  overrides: Partial<HtmlRenderBridgeTarget> = {},
  bridge = true,
  now: () => number = () => 0,
) {
  const posted: Array<Record<string, unknown>> = [];
  const waiting = new Map<unknown, (message: Record<string, unknown>) => void>();
  const sent: Array<Parameters<HtmlRenderBridgeTarget["send"]>[0]> = [];
  const toolCalls: Array<Parameters<HtmlRenderBridgeTarget["callTool"]>[0]> = [];
  const saved: Array<Readonly<Record<string, string>>> = [];
  const host = makeHtmlRenderHost({
    post: (message) => {
      const record = message as Record<string, unknown>;
      posted.push(record);
      waiting.get(record.id)?.(record);
    },
    copy: async () => undefined,
    now,
    bridge: bridge
      ? {
          renderId: "thread-1-0f6b2b4e-html",
          title: "Quiz",
          send: async (message) => {
            sent.push(message);
          },
          callTool: async (input) => {
            toolCalls.push(input);
            return { _tag: "Completed", isError: false, value: { ok: true } };
          },
          confirm: async () => true,
          saveState: (state) => saved.push(state),
          ...overrides,
        }
      : undefined,
  });
  /** Resolves once the host has answered the request with this id. */
  const response = (id: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const answered = posted.find((message) => message.id === id);
      if (answered === undefined) waiting.set(id, resolve);
      else resolve(answered);
    });
  return { host, posted, sent, toolCalls, saved, response };
}

describe("makeHtmlRenderHost", () => {
  it("takes quick real clicks and caps messages, not tool calls", async () => {
    let time = 0;
    const { host, sent, toolCalls, response } = setup({}, true, () => time);
    const act = async (at: number, request: Record<string, unknown>) => {
      time = at;
      host.receive(click, active);
      host.receive(request, active);
      return response(String(request.id));
    };
    // Three reads and a send, half a second apart, are four real clicks.
    await act(0, callTool("a", "t3_thread_read"));
    await act(500, callTool("b", "t3_thread_read"));
    await act(1_000, callTool("c", "t3_thread_read"));
    await act(1_500, send("pick", "One"));
    // Page script can post the notice itself while the click's activation lasts.
    await act(1_600, send("second", "Two"));
    await act(1_700, send("third", "Three"));
    const capped = await act(1_800, send("capped", "Four"));
    await act(6_600, send("later", "Five"));

    expect(toolCalls).toHaveLength(3);
    expect(sent.map((message) => message.text.split(") ")[1])).toEqual([
      "One",
      "Two",
      "Three",
      "Five",
    ]);
    expect(capped).toMatchObject({ error: { message: expect.stringContaining("Wait a moment") } });
  });

  it("sends one message per click, marked as coming from the page", async () => {
    const { host, sent, response } = setup();
    host.receive(click, active);
    host.receive(send("first", "  Answer B "), active);
    host.receive(send("second", "Answer C"), active);

    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message?.text).toMatch(
      /^\[From Quiz\]\(t3-context:\/\/v1\/html-render\/[^)]+\) Answer B$/,
    );
    expect(message?.context.records).toEqual([
      expect.objectContaining({ kind: "html-render", renderId: "thread-1-0f6b2b4e-html" }),
    ]);
    expect(await response("first")).toMatchObject({ result: null });
    expect(await response("second")).toMatchObject({ error: { code: -32000 } });
  });

  it("gives no credit for a click while the reader is not using the frame", async () => {
    const { host, sent, response } = setup();
    host.receive(click, idle);
    host.receive(send("background", "hi"), active);
    host.receive(click, active);
    host.receive(send("unfocused", "hi"), idle);
    expect(sent).toEqual([]);
    expect(await response("background")).toMatchObject({ error: { code: -32000 } });
    expect(await response("unfocused")).toMatchObject({ error: { code: -32000 } });
  });

  it("refuses empty text", async () => {
    const { host, response } = setup();
    host.receive(click, active);
    host.receive(send("empty", "   "), active);
    expect(await response("empty")).toMatchObject({ error: { code: -32602 } });
  });

  it("asks before a tool that changes things and returns its result", async () => {
    const results: Array<HtmlRenderCallToolResult> = [
      { _tag: "ConfirmationRequired", title: "Send to a T3 thread" },
      { _tag: "Completed", isError: false, value: { sequence: 3 } },
    ];
    const asked: Array<unknown> = [];
    const { host, toolCalls, response } = setup({
      callTool: async (input) => {
        toolCalls.push(input);
        return results.shift()!;
      },
      confirm: async (request) => {
        asked.push(request);
        return true;
      },
    });
    host.receive(click, active);
    host.receive(callTool("send", "t3_thread_send", { message: "go" }), active);

    expect(await response("send")).toMatchObject({ result: { sequence: 3 } });
    expect(asked).toEqual([
      { page: "Quiz", tool: "Send to a T3 thread", arguments: { message: "go" } },
    ]);
    expect(toolCalls.map((call) => call.confirmed)).toEqual([false, true]);
  });

  it("does not run a tool the reader declined", async () => {
    const { host, toolCalls, response } = setup({
      callTool: async (input) => {
        toolCalls.push(input);
        return { _tag: "ConfirmationRequired", title: "Interrupt a thread" };
      },
      confirm: async () => false,
    });
    host.receive(click, active);
    host.receive(callTool("interrupt", "t3_thread_interrupt"), active);
    expect(await response("interrupt")).toMatchObject({
      error: { message: "Declined by the user." },
    });
    expect(toolCalls).toHaveLength(1);
  });

  it("rejects with the tool's own error text", async () => {
    const { host, response } = setup({
      callTool: async () => ({ _tag: "Completed", isError: true, value: "Thread not found." }),
    });
    host.receive(click, active);
    host.receive(callTool("read", "t3_thread_list"), active);
    expect(await response("read")).toMatchObject({ error: { message: "Thread not found." } });
  });

  it("saves state only for viewers who may change it, within the size cap", () => {
    const writer = setup();
    writer.host.receive(
      { jsonrpc: "2.0", method: "t3/notifications/storage", params: { state: { a: "1" } } },
      idle,
    );
    writer.host.receive(
      {
        jsonrpc: "2.0",
        method: "t3/notifications/storage",
        params: { state: { big: "x".repeat(70 * 1024) } },
      },
      idle,
    );
    expect(writer.saved).toEqual([{ a: "1" }]);

    const guest = setup({ saveState: undefined });
    guest.host.receive(
      { jsonrpc: "2.0", method: "t3/notifications/storage", params: { state: { a: "1" } } },
      idle,
    );
    expect(guest.saved).toEqual([]);
  });

  it("lets a page outside a thread copy but not send", async () => {
    const { host, response } = setup({}, false);
    host.receive(click, active);
    host.receive(send("send", "hi"), active);
    host.receive({ jsonrpc: "2.0", id: "copy", method: "t3/copy", params: { text: "x" } }, active);
    expect(await response("send")).toMatchObject({ error: { code: -32000 } });
    expect(await response("copy")).toMatchObject({ result: null });
  });
});
