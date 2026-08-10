# Disabled upstream mobile updates

## Fork requirement

Mobile builds from this fork must run the JavaScript bundle embedded in the signed app. They must
not download updates from upstream's Expo project, because those updates can replace fork-only
behavior such as accountless connections, disabled browser tools, and native agent awareness.

## Implementation

- Expo Updates remains installed for upstream compatibility, but `apps/mobile/app.config.ts`
  disables the native update loader and removes the upstream project URL.
- The existing update-check runtime observes `Updates.isEnabled` and becomes a no-op when native
  updates are disabled.

## Maintenance

Keep updates disabled during upstream merges. If this fork later owns a separate Expo project,
replace this patch with fork-specific update configuration and verify that its runtime/channel can
never receive upstream bundles.
