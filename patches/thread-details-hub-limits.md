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
- Each row projects its window until every account has refilled once, at the pace its hub accounts
  spent over the last three days once the server has a day of their readings, and otherwise at the
  pace the window shows so far,
  and answers two questions: does the pool run dry before a refill lands, and does an account reset
  with room left? The bar is solid for room the pace uses, dashed for room that resets unused, and
  amber for room it is short, with a notch at what the pace needs. The tooltip says when it runs
  out, what resets unused, and how much faster or slower stays covered. Claude's model-scoped
  weeklies, such as Fable's, get no projection; Hauke doesn't plan around them.

## Implementation

`apps/web/src/components/chat/ThreadDetailsUsage.logic.ts` (`hubPoolFor`, `otherDriverPools`) is
fork-owned. `ThreadDetailsUsage.tsx` renders their windows as `PoolRow`s under `DriverCaption`s,
and `ChatView.tsx` passes the environment id in the panel's `usage` input. `CodexProvider.ts` takes `model_provider` from the
`config/read` call it already makes for the service tier.

`projectLimitWindows` and `projectionPaces` in `packages/shared/src/usageLimits.ts` are fork-owned.
They spend a pool the way infra's claude-pool priorities route it
(`~/infra/modules/features/claude-pool/priorities.py`): within a day of its weekly reset an account
takes every new session, otherwise the one with the most room per hour does. Change both together.
Codex accounts on the hub keep CLIProxyAPI's round robin, so a Codex pool can waste more than the
projection shows.

The fill alone misjudges a pool: it reads every account as spending in parallel, while the pool
drains one at a time, and an account that just reset hides its last week. So `UsageLimitSources`
records each hub account window's readings (`apps/server/src/usage/usageSpendHistory.ts`, kept in
`usage-spend-history.json` under the state directory so deploys don't lose them) and publishes the
measured `recentSpend` on the window. The projection uses it when every member has it.

## Removal

Drop the hub fallback when upstream's thread details usage row falls back to hub accounts, the
other providers' groups when upstream's row lists every provider, and the projection when upstream
draws one. Upstream tracks the bug in
pingdotgg/t3code#30990, and pingdotgg/t3code#30634 pools the hub accounts the same way. Neither covers Codex's leftover login; that part stays until upstream checks Codex's model
provider before reading limits.
