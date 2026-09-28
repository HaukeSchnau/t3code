# Z.AI Coding Plan usage limits

## Purpose

Report the coding and MCP allowances of a Z.AI Coding Plan configured in OpenCode through upstream's
provider usage limits, so they show under **Usage → Limits** and in `/usage-limits` for OpenCode.
Upstream's OpenCode driver only reads OpenCode Go.

## Contract

- Discover the plan from OpenCode's resolved provider inventory: a provider serving a model whose API
  URL is `https://api.z.ai` or `https://open.bigmodel.cn`, with a resolved API key. A session uses its
  selected model's provider; the status probe, which has no model, takes the first matching provider.
- Send the API key only to the matching HTTPS quota endpoint. Never log it, persist it, or send it
  through T3 Code's client contracts.
- Publish upstream usage windows with stable ids: `zai_5h` (session), `zai_weekly` (weekly), and
  `zai_mcp` (monthly MCP allowance for Web Search, Web Reader, and ZRead calls). A response without a
  coding window publishes nothing.
- The OpenCode status probe merges these windows into the OpenCode Go result. Without a Go key the Go
  read reports `unsupported`, and upstream never applies runtime updates to an unsupported snapshot,
  so a configured Z.AI provider replaces it with the Z.AI windows, or with `probeFailed` when the quota
  read fails.
- Between probes the adapter refreshes after a matching session starts, after completed turns, and
  every five minutes while an identified Z.AI session is alive. One scheduler is shared across
  sessions; requests coalesce and run at most once a minute. Results travel as
  `account.rate-limits.updated` and merge by window id.
- Refreshes are best effort. A failed lookup or quota read keeps the last published windows.
- A 429 from a Z.AI model takes the earliest exhausted window's reset as its retry time.

## Surfaces

- Discovery and refreshes run on the server, so local, remote, relay, and tunnel connections behave
  the same.
- The windows belong to the OpenCode instance, not to GLM models: `/usage-limits` shows them for any
  OpenCode model, beside any OpenCode Go windows. Usage → Limits shows them on web, desktop, and
  mobile.
- The historical Usage page does not include GLM activity.

## Upstream touch points

- `apps/server/src/provider/zaiUsage.ts` (fork-owned)
- `apps/server/src/provider/Drivers/OpenCodeDriver.ts`: the probe merge, and `withOpenCodeClient`,
  which workspace inventory loading shares
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`: the refresh scheduler and the 429 retry time

## Verification

- `zaiUsage.test.ts` covers window mapping, rejected responses, allowed hosts, where the key is sent,
  and a probe result taking a live update through upstream's `applyUsageLimitsUpdate`.
- `OpenCodeAdapter.test.ts` covers provider discovery, startup publication, five-minute polling, and
  the 429 retry time.

## Maintenance

Z.AI's quota response is not part of OpenCode's SDK contract. Keep the decoder permissive about plan
metadata, but require the documented success shape and a coding window before publishing. Retire this
patch when upstream's OpenCode driver reads Z.AI plans itself.
