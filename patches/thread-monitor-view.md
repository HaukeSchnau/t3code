# Thread Monitor View

## Purpose

Adds a global `/monitor` view for watching multiple active threads at once.

The monitor is fork-specific product UX for users who run several agent threads concurrently. It
shows running, interrupted/error, actionable, and recently completed threads in a stable-order
compact grid. Each tile hydrates the thread transcript, exposes a quick follow-up composer, and
supports direct approval, simple user-input, interrupt, and full-thread navigation actions.

## Requirements

- Tile order must remain stable while activity streams in. New candidates append into the stored
  monitor order instead of constantly resorting.
- The view is global across environments and projects.
- Full thread detail subscriptions should be retained only for visible or near-visible tiles to
  avoid making the monitor a global full-history render surface.
- Running/live badges should only reflect active session statuses (`starting` or `running`). Idle
  ready sessions and stale running latest-turn rows must not keep tiles marked as running.
- Tiles should favor skimmable chat transcripts over maximum density: use larger responsive cells,
  tight gutters, a compact but full-featured quick-follow-up composer, and count-aware row/column
  packing so active sets use the available monitor viewport instead of leaving a mostly blank
  canvas. Medium sets should avoid sparse last rows such as a five-plus-one layout when a balanced
  three-by-two wall fits.
- The monitor route should not render its own title/header bar; the sidebar already provides
  navigation context, and the grid should receive the full route viewport.
- Tile follow-up composers should reuse the shared chat composer editor/action primitives where
  practical, trimming only global controls such as model selection and attachments that are unsafe
  in the compact monitor surface.
- Complex user-input forms that cannot be represented safely in a compact tile should route to the
  full thread instead of offering a partial response UI.

## Maintenance Notes

- Route: `apps/web/src/routes/_chat.monitor.tsx`
- Main UI: `apps/web/src/components/MonitorView.tsx`
- Sidebar entry: `apps/web/src/components/Sidebar.tsx`
- Generated TanStack route tree must include `/monitor`.

When syncing upstream, keep this patch if upstream lacks a comparable multi-thread monitor. If an
upstream implementation appears, prefer it only if it preserves stable order, global scope, compact
transcript tiles, and direct action support.
