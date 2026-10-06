# Unknown remote refinement cache

## Why this patch exists

A remote on a host T3 does not recognize, such as `git.schnau.dev`, is refined by asking every
forge CLI whether it is logged in there (`glab auth status`, `tea login list`, fj's keys). Upstream
caches that only inside its 5-second provider detection for a checkout, and pull request reads that
pass their own remote context refine on every call. On srv-2 that spawned `tea` or `glab` about six
times a second, around a second each under load.

## Requirements

- One refinement per remote within five minutes, whichever checkout asks. The answer depends on the
  remote's host, URL and requested web host, and on CLI logins, never on the checkout.
- Each caller keeps its own remote name and other context. Only the refined provider is shared.
- A CLI login or logout shows up after at most five minutes.

## Implementation

`SourceControlProviderRegistry.ts` keys an Effect `Cache` on `UnknownRemoteRefinement`, whose
equality is the remote identity. Both the checkout detection and the explicit-context path of
`resolveHandle` go through it.

## Removal

Drop this patch when upstream caches unknown remote refinement across calls.
