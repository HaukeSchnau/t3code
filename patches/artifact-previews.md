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
- Markdown documents use the existing chat renderer, including Mermaid and tables.
  A read-scoped RPC fetches only Markdown from the publishing origin, rejects
  redirects, and limits responses to 2 MiB and 15 seconds. The environment needs
  Tailnet access. Relative links and images resolve against the document URL.
- Other document frames load directly from the publishing host. Sandbox permissions
  allow interactive documents without granting top-level navigation. Nothing is
  fetched while the link merely appears in a response. Reload adds a transient
  query parameter to request a fresh document; the tab and external action retain
  the original URL. Relative assets follow the publishing host's cache headers.
- The desktop content security policy allows frames from this one publishing origin.
  Markdown uses the existing authenticated connection in local, remote, and relay modes.
  Providers and persistent server state are unaffected.
- Native mobile keeps its existing link behavior. Web on small screens uses the
  existing right-panel sheet.

## Hosting constraints

The viewing device needs Tailnet access to the publishing host. Its Caddy directory
listings set `frame-ancestors 'self'` and cannot be embedded, though published index
pages can. The root listing stays external. Unknown directory URLs may still point
at a blocked listing; the external action remains available. JSON uses the host's
native text response. Markdown is read through the environment so the publishing host does not need to grant cross-origin access.

Retire this patch when upstream supports configurable published-document origins
with equivalent web and desktop behavior.
