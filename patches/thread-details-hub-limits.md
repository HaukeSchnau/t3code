# Thread details hub limits

## Why this patch exists

On srv-2, Claude sends through a CLIProxyAPI hub with the hub's API key, so the Claude CLI reports
no subscription limits and upstream's **Usage limits** row in the thread details card reads
"Unavailable". Hauke uses that row instead of the fork's old composer meter, which this patch
replaces.

## Requirements

- When the selected provider instance reports its limits as `unsupported` and a usage limit source
  (hub) reports accounts of the same driver, the row shows the hub's pooled windows, the same
  numbers Usage → Limits leads with. Hovering a row shows the account count, the next reset that
  hands quota back, and the pace.
- A provider that reports its own windows, a failed read (`probeFailed`), or a driver no hub
  reports keeps upstream's behavior.

## Implementation

`apps/web/src/components/chat/ThreadDetailsUsage.logic.ts` (`hubPoolFor`) is fork-owned.
`ThreadDetailsUsage.tsx` renders its windows as `PoolRow`s, and `ChatView.tsx` passes the
environment id in the panel's `usage` input.

## Removal

Drop this patch when upstream's thread details usage row falls back to hub accounts. Upstream
tracks the bug in pingdotgg/t3code#30990, and pingdotgg/t3code#30634 pools the hub accounts the same
way.
