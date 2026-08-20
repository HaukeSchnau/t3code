# Provider instance handoff

## Why this patch exists

Codex account instances use separate authentication overlays while sharing the native conversation
store. Codex permits only one active writer for a conversation. Starting a replacement instance
before stopping the bound instance therefore fails with `thread ... already has an active writer`.

## Behavior

- Starting a session on a different provider instance first stops the currently bound runtime.
- The stopped binding keeps its resume cursor and records a stopped status before the replacement
  starts.
- A stop failure aborts the handoff and leaves the existing binding active.
- A replacement start failure leaves resumable stopped state instead of a false running binding.
- Same-instance restarts retain their existing behavior.

## Verification

`apps/server/src/provider/Layers/ProviderService.test.ts` verifies stop-before-start ordering,
replacement failure state, and stop failure behavior with two Codex instances.

## Maintenance

Retain this patch while upstream starts replacement provider instances before releasing the current
session. Remove it when upstream performs an ordered handoff and preserves resumable state on
failure.
