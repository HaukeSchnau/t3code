# html_render page bridge

## Why this patch exists

Upstream's `html_render` pages are one-way: a page can size itself, open links and forward
shortcuts, and nothing more. Hauke wants pages that act as small apps in a thread: answer the
agent, remember what the reader did, be replaced by newer versions, and call T3's own tools.
Upstream has no such bridge for html renders; MCP Apps cover only third-party MCP servers through
a provider session.

## Requirements

- A page calls `window.t3.send(text)`, `t3.callTool(name, args)` and `t3.copy(text)`. Sends and
  tool calls need the reader using the frame (focus plus transient activation, or the mobile
  relay's `active` flag) and one trusted click each. Sends carry an `html-render` context record,
  which the agent sees as a line saying the page wrote the message.
- `localStorage` in a page is a shim over one server-stored map per render (64 KiB), passed in the
  URL fragment at load and written back debounced. Every version shares it; last write wins.
  Guests read it and cannot write it.
- `html_render_update` publishes a render's next version as its own tool item. Clients join it
  to the render's row with a version switcher. `html_render`, `html_render_update` and
  `html_preview` accept `path` instead of `html`.
- `t3.callTool` runs only the tools in `HTML_RENDER_PAGE_TOOLS`, through the handlers `/mcp`
  registered. Tools without `Tool.Readonly` need the reader's confirmation first. The page acts
  as a client caller capped at the thread's runtime and interaction mode, so `McpToolAccess`
  applies the same checks as for an OAuth MCP client. A thread caller would need a live run for
  every write, and pages are used after the agent stops.
- Mobile loads the page in a sandboxed frame behind a relay document, like MCP apps, so the bridge
  and reported heights work there too.

## Implementation

- Server: `apps/server/src/htmlRender/HtmlRenderBridge.ts` (state, ownership, tool calls),
  `HtmlRenderState.ts`, migration 95, `apps/server/src/mcp/McpToolDirectory.ts` (records what
  `/mcp` registers), `toolkits/html/`.
- Page side: `HTML_RENDER_BRIDGE_SCRIPT` in `packages/shared/src/htmlRender.ts`, injected at
  publish, so pages published before this patch keep the old bootstrap.
- Clients: `packages/client-runtime/src/htmlRender/host.ts`, web `useHtmlRenderHost.ts`, mobile
  `HtmlRenderWebView.tsx`.

## Removing it

Remove this patch if upstream ships a request/response bridge for html renders with saved state,
versions and access to T3's own tools, or if MCP Apps grow a host-side tool source that html
renders can use without a provider session.
