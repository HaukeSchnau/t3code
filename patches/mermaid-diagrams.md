# Mermaid diagrams

## Requirement

Render agent-provided Mermaid fences in web and desktop, with access to the
original source and existing copy controls. Use local rendering for hosted,
local, remote, and tunnel connections alike.

## Implementation

- `apps/web/src/components/ChatMarkdown.tsx` recognizes Mermaid fences and adds
  the source/diagram toggle. The shared Markdown renderer also covers file
  previews and other Markdown views; no provider or protocol changes are needed.
- `MermaidDiagram.tsx` waits for streaming to finish, discards obsolete results,
  and retains source on errors.
- `apps/web/src/lib/mermaid.ts` lazily imports pinned Mermaid, serializes its
  global configuration and rendering, and cleans up its temporary DOM. Strict
  rendering and SVG images isolate output from the application. HTML labels are
  disabled because the result is displayed as an image.
- Native mobile retains its code renderer. It needs a separate implementation
  because Mermaid requires a browser DOM.

## Verification

Focused component tests cover streaming, invalid source recovery, and obsolete
renders after source/theme changes. `ChatMarkdown.test.tsx` covers the
source/diagram toggle, original-code copying, and existing code controls.
The 52 focused tests, web typecheck, targeted lint, and Nix release contract check
pass. Lint retains two existing warnings in unrelated Markdown code. Browser
verification has not been run; it requires maintainer approval.

## Upstream

Retire this patch when upstream supports Mermaid fences with source access,
local rendering, and safe handling of streamed or invalid content.
