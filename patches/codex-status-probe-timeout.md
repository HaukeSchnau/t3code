# Codex Status Probe Timeout

## Requirement

A Codex status probe that runs out of time must not mark a working Codex instance as unavailable.
On a busy self-hosted server, the probe spawns `codex app-server` and reads the account over the
network while other provider and workspace work shares the event loop. It regularly takes 3 to 9
seconds and sometimes more than 10. The next probe only runs when a client reports foreground
activity, so one timeout could leave Codex unavailable for hours.

## Why upstream does not meet it

Upstream gives Codex its own probe budget (`CODEX_AUTH_PROBE_TIMEOUT_MS`, 20 seconds) and bounds
skills, models and rate-limit discovery by a deadline inside it, so slow discovery keeps the account
result. A probe that runs out of the whole budget still publishes `status: "error"` ("Timed out
while checking Codex app-server provider status."), with no fallback to the last known state.

## Design

- Upstream's 20-second budget replaces the fork's 30 seconds. Late discovery no longer fails the
  probe, so only the spawn, `initialize` and the account read count against it.
- `makeCodexProviderStatusCheck` in `apps/server/src/provider/CodexProvider.ts` remembers each
  Codex instance's last ready snapshot. When a probe times out, `checkCodexProviderStatus`
  republishes that snapshot and marks usage as `probeFailed`, so the registry keeps the usage limits
  it already published. Without a ready snapshot, the timeout still reports an error.
- Any finished probe replaces the remembered snapshot, so a real failure such as a signed-out
  account shows immediately.
- `apps/server/src/provider/Drivers/CodexDriver.ts` uses the remembering check. Upstream's managed
  Codex setup (`CodexManagedProvider.ts`) still calls `checkCodexProviderStatus` without it.

## Removal

Remove this when upstream either keeps the last known provider state on inconclusive probes or
re-probes soon after a failed probe.

## Verification

`ProviderRegistry.test.ts`: "keeps the last ready status when a later probe times out".
