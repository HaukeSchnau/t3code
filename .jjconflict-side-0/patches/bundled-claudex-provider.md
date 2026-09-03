# Bundled Claudex Provider

## Goal

Expose the personal Claudex runtime as a first-class T3 Code provider profile on every managed
installation while reusing the existing Claude Code driver.

## Behavior

- `Claudex` is always visible, enabled by default, and non-deletable.
- It has a dedicated orange X mark, leaving native Claude on the standard Claude icon without an
  ambiguous `CL` instance badge.
- Users may disable it or edit its provider-instance settings.
- It launches `claudex`, shares the normal Claude configuration and skills, and offers only
  `gpt-5.6-sol` by default.
- Claude and Claudex use distinct continuation groups, so a native Claude session is never resumed
  through the routed runtime (or vice versa).
- Deleting the persisted entry restores the bundled defaults during runtime/UI projection.
- Claude profiles can independently exclude T3 Code's built-in Claude model catalog via
  `includeBuiltInModels`.
- Pending and checked snapshots both preserve the custom-only catalog, so stale built-in models
  never appear while provider probing is in flight.
- Claudex's wrapper-level `auth status` is authoritative even when Claude SDK initialization can
  read proxy-token metadata.
- The managed Claudex profile suppresses Claude's self-update advisory and labels authenticated
  sessions as CLIProxyAPI; the host wrapper owns backend readiness and update policy.
- Bundled-instance behavior is limited to restoring and protecting the profile. Proxy auth,
  catalog authority, and continuation isolation are explicitly Claudex-only policies.

## Upstream Touch Points

- `packages/shared/src/bundledProviderInstances.ts`
- `packages/contracts/src/settings.ts`
- `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts`
- `apps/server/src/provider/Layers/ClaudeProvider.ts`
- `apps/server/src/provider/Layers/ProviderRegistry.ts`
- `apps/server/src/provider/providerStatusCache.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/components/Icons.tsx`
- `apps/web/src/components/chat/ProviderInstanceIcon.tsx`
- `apps/web/src/providerInstances.ts`
- Claude and provider architecture documentation

## Infrastructure Contract

The application does not package or authenticate Claudex. The server host must put a working
`claudex` executable on the T3 Code service PATH. The personal infrastructure repository supplies
Claude Code, CLIProxyAPI, skills, and authentication state on macOS and srv-2.

## Verification

- Shared/runtime tests cover bundled default restoration, override precedence, and Claude settings.
- Provider tests prove that Claude and Claudex coexist with independent auth, catalogs, update
  ownership, and continuation identities.
- Run focused tests and typechecks for the touched packages.
