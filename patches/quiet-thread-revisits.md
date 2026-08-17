# Quiet Thread Revisits

## Context

Full thread-detail state is deliberately released as soon as its last visible owner unmounts. This
keeps inactive transcripts and provider activity out of renderer memory, but revisiting a thread
must recreate its detail subscription and reconcile the persisted snapshot with the server.

That reconciliation normally resumes from the cached event sequence rather than downloading the
thread snapshot again. Cached messages are already usable while it runs, so presenting the internal
catch-up as a foreground `Syncing messages` or connected `Updating` banner makes routine navigation
look blocked and becomes especially distracting over a slow remote connection.

The legacy web sidebar already retained a small set of likely destinations, but the default sidebar
did not use that prewarmer.

## Required behavior

- Web and mobile foreground `Loading` only when no conversation content is available.
- Cached conversation content remains visible while thread-detail and environment-shell state
  reconcile in the background. A connected cache reconciliation does not show `Syncing messages`,
  `Updating`, or an equivalent mobile status.
- Offline, reconnecting, unavailable, and failed connection states remain visible even when cached
  content is present.
- Both web sidebar implementations use the same bounded prewarmer.
- Prewarming considers at most the first two rendered thread keys. The bound applies before key
  parsing or component creation, so its CPU, renderer-memory, and server-subscription cost does not
  grow with sidebar length.
- The two background warmups leave one of the three thread-detail catch-up permits available for a
  cold foreground navigation.
- The active chat and sidebar owners share the same keyed atom. When the open thread is among the
  prewarmed entries, it does not create a second detail state machine.

## Impact model

The default sidebar previously retained no inactive thread details, leaving one active detail
subscription in the ordinary single-chat case. This patch permits at most two sidebar-owned
details, so the upper bound is three active detail subscriptions when the open thread is outside the
prewarm window, and two when it overlaps. The focused component test locks down the two-owner bound
and ordering.

The tradeoff is intentional: two live, windowed details use more renderer memory and server work
than a cold sidebar, but avoid foreground catch-up on the most likely switches. Do not raise the
limit without measuring renderer memory and `subscriptions.detail.active` on a representative
database.

## Maintenance notes

- Keep cache residency and live subscription lifetime distinct in future architecture work. A
  byte-bounded data-only LRU plus thread-scoped freshness watermarks could eventually replace live
  prewarming without reintroducing foreground reconciliation.
- Do not restore a foreground cached-sync banner merely because the internal state reports
  `cached` or `synchronizing`; those states describe freshness, not whether usable content exists.
- If sidebar ordering changes, pass the final rendered thread-key order to the shared prewarmer so
  keyboard navigation, row order, and likely destinations stay aligned.

## Verification

- `apps/web/src/threadSync.test.ts`
- `apps/web/src/components/chat/ThreadSyncStatusPill.test.tsx`
- `apps/web/src/components/chat/trainNetworkExperience.test.ts`
- `apps/web/src/components/sidebar/SidebarThreadDetailPrewarmer.test.tsx`
- `apps/mobile/src/features/threads/trainNetworkPresentation.test.ts`
- Targeted web and mobile typechecks.
- An integrated browser pass should switch repeatedly among prewarmed and cold threads on seeded
  data, confirm cached revisits render without bottom banners, and compare live detail-subscription
  counts against the bounds above.
