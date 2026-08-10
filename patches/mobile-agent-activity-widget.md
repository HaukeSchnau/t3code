# Mobile Agent Activity Widget

## Goal

Keep the iOS home-screen and Lock Screen widget aligned with the fork's relay-backed agent
awareness feature. The same `AgentActivity` widget extension also hosts the Live Activity, but
WidgetKit and ActivityKit store separate layouts and update state through different APIs.

## Requirements

- Register both the `AgentActivity` home widget and the `AgentActivity` Live Activity factory.
- Every home-widget family must apply SwiftUI's `containerBackground(..., "widget")` modifier;
  newer iOS versions replace non-conforming widgets with a system error.
- Support `systemSmall`, `systemMedium`, and `accessoryRectangular`, matching `app.config.ts`.
- Reconcile the widget snapshot from the authenticated relay on sign-in, environment connection,
  and foreground activation. ActivityKit pushes update only the Live Activity, not the home widget.
- Treat a relay response with `aggregate: null` as authoritative idle state, but retain the last
  useful snapshot when the snapshot request itself fails.
- Clear the widget on cloud sign-out and seed it immediately when local agent work begins.
- Keep the serialized widget render function self-contained; Expo serializes it into the extension
  bundle and cannot resolve module-local rendering helpers.
- Enable the `remote-notification` background mode so ActivityKit and notification updates can be
  processed while the app is suspended.
- Keep the APNs entitlement, embedded relay registration environment, and actual signing mode in
  agreement. Local Xcode builds use `T3CODE_APNS_ENVIRONMENT=sandbox`; distribution builds default
  to production.
- Keep the widget extension's marketing version and build number aligned with the containing app;
  App Store validation rejects mismatched extension metadata.

## Upstream Touch Points

- `apps/mobile/app.config.ts`
- `apps/mobile/plugins/lib/syncWidgetBuildVersions.cjs`
- `apps/mobile/plugins/withWidgetLogoAsset.cjs`
- `apps/mobile/src/widgets/AgentActivity.tsx`
- `apps/mobile/src/features/agent-awareness/remoteRegistration.ts`

Expo SDK upgrades need special attention: `expo-widgets` removed its hard-coded container
background in SDK 56, making the `@expo/ui` modifier an application responsibility.

## Verification

- Run the focused `AgentActivity` and remote-registration tests.
- Typecheck `@t3tools/mobile` and run the native static checks.
- Prebuild and install an iOS app with the widget/app-group entitlements.
- Inspect the signed app's `aps-environment`, `UIBackgroundModes`, embedded Expo config, and widget
  extension version before testing relay delivery.
- On a physical device, confirm an existing widget no longer shows “Please adopt
  containerBackground API” and renders idle or aggregate content after opening the app.
