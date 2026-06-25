# Hosted Pairing Reliability

## Why this patch exists

Hosted pairing links can point `app.t3.codes` at private or tailnet backends. Modern browsers may block
that direct fetch from a public origin with local/private network access or CORS policy before the
one-time token reaches the backend. The old flow surfaced a generic retry path, which made a policy-level
failure look flaky.

## Behavior

- Hosted pairing URLs may include an optional `environmentId` query parameter.
- When that id is present, the hosted pairing page first tries to save an already linked T3 Connect
  relay environment without spending the one-time token.
- If T3 Connect is unavailable or the environment is not linked, the page falls back to direct bearer
  pairing.
- Browser local/private-network denial errors disable blind retry and show a direct backend pairing
  handoff URL. The token stays in the URL hash for both hosted and direct handoff URLs.
- The `/pair` route detects hosted pairing data from the router location and the browser location so
  hash/query credential links do not get misclassified as plain hosted-static routes.

## Requirements

- Do not send hosted pairing credentials in search params when generating new links.
- Do not spend a one-time token if the relay environment can be registered first.
- Keep direct fallback available for environments that are not linked to T3 Connect.
- Treat browser policy denial as deterministic; retrying the same hosted-origin fetch should not be the
  primary recovery path.

## Maintenance Notes

If upstream adds first-class relay pairing links, prefer that protocol over the optional `environmentId`
hint. Until then, keep this patch narrow: relay-first only for already linked environments, direct
same-origin fallback for everything else.
