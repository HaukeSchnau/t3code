# Bundled Claudex Provider

## Goal

Expose the personal Claudex runtime as a first-class T3 Code provider profile on every managed
installation while reusing the existing Claude Code driver.

## Behavior

- `Claudex` is always visible, enabled by default, and non-deletable.
- Users may disable it or edit its provider-instance settings.
- It launches `claudex`, shares the normal Claude home, and offers only `gpt-5.6-sol` by default.
- Deleting the persisted entry restores the bundled defaults during runtime/UI projection.
- Claude profiles can independently exclude T3 Code's built-in Claude model catalog via
  `includeBuiltInModels`.

## Upstream Touch Points

- `packages/contracts/src/providerInstance.ts`
- `packages/contracts/src/settings.ts`
- `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts`
- `apps/server/src/provider/Layers/ClaudeProvider.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/providerInstances.ts`
- Claude and provider architecture documentation

## Infrastructure Contract

The application does not package or authenticate Claudex. The server host must put a working
`claudex` executable on the T3 Code service PATH. The personal infrastructure repository supplies
Claude Code, CLIProxyAPI, skills, and authentication state on macOS and srv-2.

## Verification

- Contract tests cover bundled default restoration, override precedence, and Claude settings.
- Provider tests prove that routed Claude profiles can publish only their custom model catalog.
- Required fork gates: `vp check` and `vp run typecheck`.
