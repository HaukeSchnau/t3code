# Claude Usage Limits Freshness

## Purpose

Keep Claude subscription limits current while a provider session is alive, and make the shared
composer meter explicit when its last successful observation is no longer current.

## Contract

- Fetch Claude subscription limits when the first live session starts.
- Share one refresh scheduler across every Claude thread in a provider instance. Only one request may
  be in flight, and requests that arrive during the one-minute cooldown must be coalesced rather than
  discarded.
- Refresh after completed turns and every five minutes while at least one Claude session remains
  alive. A provider `rate_limit_event` bypasses the cooldown.
- Never create or retain a hidden Claude process solely to refresh limits. Once session reaping closes
  the final query, polling has no provider context and performs no work.
- Publish a new usage observation only after the experimental Claude usage control succeeds and its
  response normalizes correctly. Failures are best-effort and leave the prior observation timestamp
  unchanged.
- Anchor forecasts to the observation's `updatedAt` timestamp. Reset countdowns may advance with wall
  time, but the observed percentage must not imply newly measured usage.
- After ten minutes without a successful observation, render the meter in a neutral stale state,
  show how old the observation is, and pause forecast and depletion claims.
- Treat a passed reset time as a previous window awaiting refresh; never describe it as a current
  window that “resets in expired.”
- Reuse the existing normalized rate-limit event and snapshot contracts. This patch adds no database
  migration or wire schema.

## Surfaces

- The Claude adapter owns refresh scheduling for local, remote, and tunnel connections.
- The shared web composer meter covers web and desktop. Mobile does not currently render the meter.

## Verification

- Claude adapter tests cover the startup fetch, retained post-turn refresh, and five-minute polling.
- Usage derivation tests cover observation-anchored forecasts, stale observations, and expired
  windows.
- Composer render tests cover stale and refresh-pending accessible copy.

## Maintenance

The Claude SDK usage control is explicitly experimental. Replace it with Anthropic's stable account
usage API when one becomes available, preserving the coalescing and freshness behavior above.
