# Quiet thread revisits

## Context

Full thread-detail state is released as soon as its last visible owner unmounts. This keeps
inactive transcripts out of renderer memory, but a revisit must recreate the detail subscription
and catch up from the cached event sequence. Cached messages render while that runs. Upstream shows
`Syncing messages...` during the catch-up, which makes routine navigation look blocked, especially
over a slow remote connection.

## Required behavior

This covers web and desktop. Mobile runs upstream's behavior, a delayed `Syncing messages...` pill
in `ThreadDetailScreen.tsx`.

- Show `Loading messages...` only when no conversation content is available. `threadSync.ts` has
  no syncing phase.
- Offline, reconnecting, unavailable, and failed connection states stay visible over cached content
  through the [connection freshness](connection-freshness-projection.md) banner.
- Both sidebars (`Sidebar.tsx` and `LegacySidebar.tsx`) mount the shared
  `SidebarThreadDetailPrewarmer` with their final rendered thread-key order. Upstream prewarms
  only in its legacy sidebar. The prewarmer keeps the first two thread details mounted
  (`SIDEBAR_THREAD_PREWARM_LIMIT` in `Sidebar.logic.ts`, three upstream). The limit applies before
  key parsing, so its cost does not grow with sidebar length.
- Two warmups leave one of the three [thread catch-up permits](bounded-thread-reconnect.md) for a
  cold foreground navigation.
- The chat view and the prewarmer share the keyed thread atom through `useEnvironmentThreadMount`
  in `state/threads.ts`. An open thread inside the warm window gets no second state machine.

## Cost

At most three thread details stay subscribed, two warm sidebar entries plus a cold active thread.
When the active thread is inside the warm window, two remain. Do not raise the limit without
measuring renderer memory and server subscription load on a representative database. Do not bring
back a cached-sync banner because the state reports `cached` or `synchronizing`. Those states
describe freshness, not whether usable content exists.

## Removal

Retire this patch when upstream keeps cached revisits quiet and prewarms in its default sidebar
without taking every catch-up permit.

## Verification

- `apps/web/src/threadSync.test.ts`
- `apps/web/src/components/sidebar/SidebarThreadDetailPrewarmer.test.tsx`
- `apps/web/src/components/sidebar/SidebarThreadDetailPrewarmer.lifecycle.test.tsx`
- `apps/web/src/components/chat/TrainNetworkStatus.test.tsx`
- `apps/web/src/components/chat/trainNetworkExperience.test.ts`
