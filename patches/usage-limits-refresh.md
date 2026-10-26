# Usage limits refresh

## Requirement

Subscription limits must stay current while any client is connected, and refreshing Limits must
answer in about a second. Upstream reads quota only inside provider status probes and the hub's
loop, and both run on the provider health check interval only while a client is focused or was
touched in the last 45 seconds. A refresh waits for full probes that start the Claude CLI and
`codex app-server`, which took 7 to 25 seconds on srv-2. Anthropic's `/api/oauth/usage` answers 429
per account when it is read too often, and upstream cannot tell that apart from any other failure.

## Design

- `apps/server/src/usage/UsageLimitsRefresh.ts` reads the hubs and every provider that can read its
  quota directly every two minutes while any client holds a WebSocket connection
  (`SessionStore.hasConnectedSession`), independent of the provider health check interval. It does
  not use BackgroundPolicy leases: on srv-2 no `server.reportClientActivity` call arrived from the
  desktop app (0.0.45, October 2026) in any trace, so lease-gated work never ran. Upstream's hub
  loop stops at an interval of 0; limits keep refreshing. `server.refreshProviders` with
  `usageLimitsOnly` runs the same reads at once (`readUsageLimits`), and providers without a direct
  reader run their status probe instead. Older servers ignore the flag and run a full refresh. The
  hub's own polling loop in `UsageLimitSources.ts` is gone. Web `UsagePage.tsx` and mobile
  `features/usage/usageLimitsRefresh.ts` send the flag, except right after a provider is enabled
  (`afterPending`), which needs a full status probe.
- `makeManagedServerProvider` (`packages/provider-core/src/server/managedProvider.ts`) takes an
  optional `readUsageLimits` and exposes `refreshUsageLimits`. `ProviderRegistry.refreshUsageLimits`
  (`apps/server/src/provider/ProviderRegistry.ts`) runs it for every instance.
- Claude reads `/api/oauth/usage?cedar_ember=1&skip_spend=1` with the login file the CLI keeps,
  which also returns banked resets (`readClaudeUsageLimits` in `provider/claudeUsageLimits.ts`).
  Codex reads `wham/usage` with the ChatGPT login in `auth.json` and keeps the probe's reset credits
  (`readCodexUsageLimits` in `provider/codexUsageLimits.ts`). Neither reads an account the last
  probe marked `unsupported`, so a Claude instance that sends through a hub never reads an unrelated
  login, and Claude skips the read when the environment overrides the login.
- A read within 30 seconds of the last one is reused, for direct readers, hub sources, and probe
  fallbacks. A direct reading is published only when its numbers change, because every provider
  update sends each client the whole provider list.
- A 429 records `rateLimitedUntil` from `Retry-After`, or five minutes later, keeps the last
  reading, and skips the account until then. The hub forwards the provider's headers. The helpers
  are in `packages/provider-core/src/server/usageLimits.ts`.
- Limits notices (`collectLimitNotices` in `packages/shared/src/usageLimits.ts`) say which reads are
  rate-limited and when the next read happens. Clients no longer wait five minutes between
  automatic checks (`refreshUsageLimits` in `packages/client-runtime/src/state/usage.ts`).

Upstream now keeps the newer windows when a cached Claude probe reports an older reading
(`resolveUsageLimitsAfterProbe`, `usageCheckedAt`), which this patch used to add.

## Removal

Remove this when upstream reads quota on its own schedule without full probes and honours provider
rate limits on quota reads.

## Verification

`managedProvider.test.ts`, `usageLimits.test.ts` (provider-core and shared),
`claudeUsageLimits.test.ts`, `codexUsageLimits.test.ts`, `UsageLimitSources.test.ts`,
`UsageLimitsRefresh.test.ts`, client-runtime `usage.test.ts`, and web
`UsagePage.refresh.browser.test.tsx`.
