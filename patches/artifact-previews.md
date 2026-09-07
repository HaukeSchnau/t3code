# Published artifact previews

## Requirement

Task documents published on Hauke's `https://files.schnau.dev` should open beside
their conversation in web and desktop, with an external-opening option. They must
work without the desktop-only integrated browser or a server-side browser session.

## Implementation

- `apps/web/src/lib/artifactLink.ts` recognizes the exact HTTPS origin and document
  paths, preserving queries and fragments. Media and downloads keep existing actions.
- Chat Markdown routes ordinary clicks to URL-backed, thread-scoped right-panel tabs.
  Modified clicks remain normal links; the context menu offers both destinations.
- The document frame loads directly from the publishing host. Sandbox permissions
  allow interactive documents without granting top-level navigation. Nothing is
  fetched while the link merely appears in a response. Reload adds a transient
  query parameter to request a fresh document; the tab and external action retain
  the original URL. Relative assets follow the publishing host's cache headers.
- The desktop content security policy allows frames from this one publishing origin.
  No provider, RPC, or server state changes are required.
- Native mobile keeps its existing link behavior. Web on small screens uses the
  existing right-panel sheet.

## Hosting constraints

The viewing device needs Tailnet access to the publishing host. Its Caddy directory
listings set `frame-ancestors 'self'` and cannot be embedded, though published index
pages can. The root listing stays external. Unknown directory URLs may still point
at a blocked listing; the external action remains available. Markdown and JSON use
the host's native text response, without a CORS fetch or proxy.

Retire this patch when upstream supports configurable published-document origins
with equivalent web and desktop behavior.
