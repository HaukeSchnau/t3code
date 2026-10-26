// @effect-diagnostics nodeBuiltinImport:off -- Runs the page bridge in a VM context instead of a browser.
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  HTML_RENDER_BRIDGE_SCRIPT,
  htmlRenderVersion,
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
} from "./htmlRender.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "iframe", "plaintext"])("keeps the bootstrap outside %s content", (tag) => {
    const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

type Listener = (event: Record<string, unknown>) => void;

/** Runs the bridge the way a framed page does, with the window and host it talks to. */
function runBridge(state?: Record<string, string>) {
  const listeners = new Map<string, Array<Listener>>();
  const posted: Array<Record<string, unknown>> = [];
  const parent = {
    postMessage: (message: unknown) => posted.push(structuredClone(message) as never),
  };
  const page: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  };
  const hash = `#t3-theme=x${state === undefined ? "" : `&t3-state=${encodeURIComponent(JSON.stringify(state))}`}`;
  NodeVM.runInNewContext(HTML_RENDER_BRIDGE_SCRIPT, {
    window: page,
    location: { hash },
    setTimeout,
    clearTimeout,
    TextEncoder,
    DOMException,
  });
  const dispatch = (type: string, event: Record<string, unknown> = {}) =>
    listeners.get(type)?.forEach((listener) => listener(event));
  const storage = page.localStorage as Storage;
  const t3 = page.t3 as {
    send: (text: string) => Promise<void>;
    callTool: (name: string, args?: unknown) => Promise<unknown>;
  };
  return { posted, dispatch, storage, t3, parent };
}

describe("page bridge", () => {
  it("restores saved state into localStorage and hands changes back to the host", () => {
    const { storage, dispatch, posted } = runBridge({ score: "3" });
    expect(storage.getItem("score")).toBe("3");
    storage.setItem("score", "4");
    storage.removeItem("missing");
    dispatch("pagehide");
    expect(posted).toEqual([
      { jsonrpc: "2.0", method: "t3/notifications/storage", params: { state: { score: "4" } } },
    ]);
  });

  it("refuses a write past the cap, as a full localStorage would", () => {
    const { storage } = runBridge();
    expect(() => storage.setItem("big", "x".repeat(70 * 1024))).toThrow(/64 KiB/);
    expect(storage.getItem("big")).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("reports only trusted clicks as activation", () => {
    const { dispatch, posted } = runBridge();
    dispatch("click", { isTrusted: false });
    dispatch("click", { isTrusted: true });
    expect(posted).toEqual([{ jsonrpc: "2.0", method: "t3/notifications/activated" }]);
  });

  it("settles t3 calls with the host's answer", async () => {
    const { t3, posted, dispatch, parent } = runBridge();
    const sent = t3.send("hi");
    const listed = t3.callTool("t3_thread_list");
    const [sendRequest, toolRequest] = posted;
    expect(sendRequest).toMatchObject({ method: "t3/send", params: { text: "hi" } });
    expect(toolRequest).toMatchObject({
      method: "t3/call-tool",
      params: { name: "t3_thread_list", arguments: {} },
    });
    dispatch("message", {
      source: parent,
      data: { jsonrpc: "2.0", id: sendRequest!.id, result: null },
    });
    dispatch("message", {
      source: parent,
      data: { jsonrpc: "2.0", id: toolRequest!.id, error: { code: -32000, message: "No." } },
    });
    await expect(sent).resolves.toBeUndefined();
    await expect(listed).rejects.toThrow("No.");
  });
});

describe("htmlRenderVersion", () => {
  it("keeps the previous title and height when an update leaves them out", () => {
    expect(
      htmlRenderVersion(reference, { renderId: reference.attachmentId, attachmentId: "v2" }),
    ).toEqual({ attachmentId: "v2", title: "Chart", height: 420 });
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      src: "data:image/png;base64,AA",
      name: "Chart",
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      src: "https://example.com/a.png",
      name: "Image",
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });
});
