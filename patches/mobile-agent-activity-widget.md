# Mobile agent activity widget

## Goal

Upstream renders the iOS home-screen and Lock Screen widget (#21163). The fork feeds it from the
paired environment's agent-awareness snapshot instead of upstream's T3 Connect relay (see
`accountless-direct-agent-awareness.md`).

## Requirements

- `remoteRegistration.ts` publishes `{ kind: "snapshot", aggregate }` through upstream's
  `publishWidget` when an environment connects and when the app returns to the foreground.
  ActivityKit pushes update only the Live Activity, not the home widget.
- A snapshot with `aggregate: null` is authoritative idle state. A failed snapshot request publishes
  nothing, so the widget keeps the last useful snapshot.
- Never publish upstream's `signed-out`, `unavailable` or `loading` sources. Their copy names
  T3 Connect, and their callers are relay token hooks that are no-ops in the fork.
- Refreshes overlap. Only the newest read for the current environment set
  (`deviceRegistrationGeneration`) may publish or prime a Live Activity, as upstream's
  `widgetSnapshotReads` guard does for its account.
- The fork reads the snapshot before registering an existing card's push token, because the
  same read decides whether to prime a card.
- Seed the widget immediately when local agent work begins. `agentActivityWidgetTimeline.ts`
  accepts `AgentActivityProps` as the aggregate for that seed, which has no thread or environment
  ids yet. Removing the last paired environment leaves the last snapshot in place.
- Enable the `remote-notification` background mode so ActivityKit and notification updates can be
  processed while the app is suspended. `expo-notifications`' `enableBackgroundRemoteNotifications`
  appends it to upstream's `UIBackgroundModes: ["audio"]`, so the signed Info.plist lists both.
- Keep the APNs entitlement, the embedded `apnsEnvironment` sent with device registration, and the
  actual signing mode in agreement. Local Xcode builds use `T3CODE_APNS_ENVIRONMENT=sandbox`;
  distribution builds default to production.
- Local Live Activity starts in `remoteRegistration.ts` pass upstream's `liveActivityStaleDate()`
  (ten minutes). It must match `STALE_AFTER_SECONDS` in `ApnsProvider.ts`, so local and pushed
  cards go stale at the same time.

## Upstream touch points

- `apps/mobile/src/features/agent-awareness/remoteRegistration.ts`
- `apps/mobile/src/widgets/agentActivityWidgetTimeline.ts`
- `apps/server/src/agentAwareness/LocalAgentAwareness.ts`
- `apps/server/src/agentAwareness/ApnsProvider.ts`

Drop the publishing rules here once upstream feeds the widget from a paired environment.

## Verification

- Run the focused remote-registration and widget timeline tests.
- Typecheck `@t3tools/mobile`.
- On a physical device, confirm the widget renders idle or aggregate content after opening the app.
