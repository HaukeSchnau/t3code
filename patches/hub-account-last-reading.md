# Hub Account Last Reading

## Requirement

A CLIProxyAPI hub account must not vanish from **Usage → Limits** because one quota read failed.
Anthropic's `/api/oauth/usage` endpoint returns HTTP 429 per account when it is read too often.
Every connected environment reads the same hub, so a pool of several accounts regularly has one
throttled account. Upstream publishes that failed read over the last good one, and the pooled view
drops accounts it cannot draw without a notice.

## Design

- `UsageLimitSources` keeps an account's last good snapshot when its read fails, using
  `resolveUsageLimitsAfterProbe`, the rule native provider probes already follow.
- An account the hub has never read successfully adds a notice to the hub's row with a count of
  such accounts. The notice does not name them, because the pooled views never print an email.
  A throttled account is counted in the rate-limit notice instead (see
  [Usage limits refresh](usage-limits-refresh.md)).
- A read the provider answers with HTTP 401 means the hub's login for that account is dead,
  not that the read failed once. The account is published with `signInRequired` and no windows,
  since it has no usable quota, and the notice asks for a new sign-in on the hub. Anthropic
  throttles an account's quota reads for an hour after about ten 401s, so `cliproxyApi.ts` does
  not read the account again until the hub rewrites its auth file (`modtime`), which a token
  refresh or a new login does. This applies to every provider in upstream's `HUB_PROVIDERS`. The hub's own `status` cannot drive this: it reports quota
  cooldowns and dead logins alike as `error`, told apart only by free text.

## Removal

Remove this when upstream keeps the last good reading for hub accounts, reports accounts it
cannot read, and stops reading accounts whose login the provider rejected.
