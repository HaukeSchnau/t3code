# Usage limits refresh

## Requirement

Subscription limits must stay current while any client is connected, and refreshing Limits must
answer in about a second. Upstream reads quota only inside provider status probes and the hub's
loop, and both run every five minutes only while a client is focused or was touched in the last
45 seconds. A refresh waits for full probes that start the Claude CLI and `codex app-server`, which
took 7 to 25 seconds on srv-2. Claude's probe result is cached for five minutes, so a refresh could
publish a five-minute-old reading under the current time and overwrite a newer one from a turn.
Anthropic's `/api/oauth/usage` answers 429 per account when it is read too often, and upstream
cannot tell that apart from any other failure.

## Design

- `UsageLimitsRefresh` reads the hubs and every provider that can read its quota directly every two
  minutes while any client holds a WebSocket connection (`SessionStore.hasConnectedSession`). It
  does not use BackgroundPolicy leases: on srv-2 no `server.reportClientActivity` call arrived from
  the desktop app (0.0.45, October 2026) in any trace, so lease-gated work never ran.
  `server.refreshProviders` with `usageLimitsOnly` runs the same reads at once. Providers without a direct reader run their status probe instead. Older
  servers ignore the flag and run a full refresh.
- Claude reads `/api/oauth/usage?cedar_ember=1&skip_spend=1` with the login file the CLI keeps,
  which also returns banked resets. Codex reads `wham/usage` with the ChatGPT login in `auth.json`
  and keeps the probe's reset credits. Neither reads an account the last probe marked
  `unsupported`, so a Claude instance that sends through a hub never reads an unrelated login.
- A read within 30 seconds of the last one is reused, for direct readers, hub sources, and probe
  fallbacks. A direct reading is published only when its numbers change, because every provider
  update sends each client the whole provider list.
- A 429 records `rateLimitedUntil` from `Retry-After`, or five minutes later, keeps the last
  reading, and skips the account until then. The hub forwards the provider's headers.
- `resolveUsageLimitsAfterProbe` keeps the newer reading by `checkedAt`, and Claude's probe dates
  its usage by when the cached probe read it.
- Limits notices say which reads are rate-limited and when the next read happens. Clients no
  longer wait five minutes between automatic checks.

## Removal

Remove this when upstream reads quota on its own schedule without full probes, honours provider
rate limits on quota reads, and dates cached probe readings.
