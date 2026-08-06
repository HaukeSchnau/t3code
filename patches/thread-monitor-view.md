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
- The Monitor must be accessible via the configurable `monitor.toggle` keybinding. The default is
  `mod+alt+g` outside terminal focus. Triggering it away from `/monitor` opens the Monitor;
  triggering it on `/monitor` returns to the most recent non-monitor app route, preserving search
  params and hash where possible.
- Tile follow-up composers intentionally mount the full shared chat composer as the baseline
  experience, including model/runtime controls, attachment support, usage meters, and primary
  actions. The composer stays collapsed by default in monitor tiles, expands inline on explicit
  follow-up intent, and remains open while a draft/error/busy state needs the full surface.
- Queued follow-up messages must be visible in monitor tiles and use the shared queued-message
  strip/actions so users can steer or remove queued work without opening the full thread. Keep the
  strip's standard inset/layering relative to the collapsed or expanded composer surface.
- Complex user-input forms that cannot be represented safely in a compact tile should route to the
  full thread instead of offering a partial response UI.
- Recently completed threads depend on `projection_threads.latest_turn_id` continuing to reference
  the latest concrete turn after a session leaves `running`. A final `thread.session-set` with
  `activeTurnId: null` must not clear that pointer, or completed threads disappear from the monitor
  before the recent-complete window expires.

## Maintenance Notes

- Route: `apps/web/src/routes/_chat.monitor.tsx`
- Main UI: `apps/web/src/components/MonitorView.tsx`
- Sidebar entry: `apps/web/src/components/sidebar/SidebarChrome.tsx`
- Shortcut handling: `apps/web/src/components/AppSidebarLayout.tsx`
- Navigation memory: `apps/web/src/monitorNavigation.ts`
- Generated TanStack route tree must include `/monitor`.
- Migration `034_BackfillProjectionThreadLatestTurnId` repairs existing projection rows whose
  `latest_turn_id` was cleared even though concrete turn rows still exist.

When syncing upstream, keep this patch if upstream lacks a comparable multi-thread monitor. If an
upstream implementation appears, prefer it only if it preserves stable order, global scope, compact
transcript tiles, and direct action support.
