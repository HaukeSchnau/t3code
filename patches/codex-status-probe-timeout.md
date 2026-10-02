# Codex Status Probe Timeout

## Requirement

A Codex status probe that runs out of time must not mark a working Codex instance as unavailable.
On a busy self-hosted server, the probe spawns `codex app-server` and reads the account over the
network while other provider and workspace work shares the event loop. It regularly takes 3 to 9
seconds and sometimes more than 10. The next probe only runs when a client reports foreground
activity, so one timeout could leave Codex unavailable for hours.

## Design

- The probe timeout is 30 seconds instead of the shared 10-second provider probe timeout.
- Each Codex instance remembers its last ready snapshot. When a probe times out, the instance
  republishes that snapshot and marks usage as `probeFailed`, so the registry keeps the usage limits
  it already published. Without a ready snapshot, the timeout still reports an error.
- Any finished probe replaces the remembered snapshot, so a real failure such as a signed-out
  account shows immediately.

## Removal

Remove this when upstream either keeps the last known provider state on inconclusive probes or
re-probes soon after a failed probe.
