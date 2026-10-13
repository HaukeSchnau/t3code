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

## Removal

Remove this when upstream keeps the last good reading for hub accounts and reports accounts it
cannot read.
