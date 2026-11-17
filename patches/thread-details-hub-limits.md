# Thread details hub limits

## Why this patch exists

On every host, Claude and Codex send through a CLIProxyAPI hub with the hub's API key. The Claude
CLI then reports no subscription limits, and upstream's **Usage limits** row in the thread details
card reads "Unavailable". Codex is routed by `/etc/codex/config.toml` (`model_provider = "pool"`,
from infra), but a ChatGPT login left in `~/.codex/auth.json` still answers Codex's usage read, so
upstream shows that login's limits instead. Hauke uses that row instead of the fork's old composer
meter, which this patch replaces. Upstream also shows only the selected provider, while Hauke wants
every subscription's room at a glance without opening Usage.

## Requirements

- When the selected provider instance reports its limits as `unsupported` and a usage limit source
  (hub) reports accounts of the same driver, the row shows the hub's pooled windows, the same
  numbers Usage → Limits leads with. Hovering a row shows the account count, the next reset that
  hands quota back, and the pace.
- Codex whose configured `model_provider` is not `openai` reports its limits as `unsupported`, like an
  API-key login, whatever login `auth.json` holds.
- A provider that reports its own windows, a failed read (`probeFailed`), or a driver no hub
  reports keeps upstream's behavior.
- Below the selected provider, the row lists every other driver on the environment that has
  readable limits, from its own login or a hub, pooled like Usage → Limits. Those groups always
  carry a caption with the provider's name, and the selected provider's group does once any follow.

## Implementation

`apps/web/src/components/chat/ThreadDetailsUsage.logic.ts` (`hubPoolFor`, `otherDriverPools`) is
fork-owned. `ThreadDetailsUsage.tsx` renders their windows as `PoolRow`s under `DriverCaption`s,
and `ChatView.tsx` passes the environment id in the panel's `usage` input. `CodexProvider.ts` takes `model_provider` from the
`config/read` call it already makes for the service tier.

## Removal

Drop the hub fallback when upstream's thread details usage row falls back to hub accounts, and the
other providers' groups when upstream's row lists every provider. Upstream tracks the bug in
pingdotgg/t3code#30990, and pingdotgg/t3code#30634 pools the hub accounts the same way. Neither covers Codex's leftover login; that part stays until upstream checks Codex's model
provider before reading limits.
