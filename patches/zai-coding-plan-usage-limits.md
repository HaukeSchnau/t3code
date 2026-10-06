# Z.AI Coding Plan usage limits

## Purpose

Report the coding and MCP allowances of a Z.AI Coding Plan configured in OpenCode through upstream's
provider usage limits, so they show under **Usage → Limits** and in `/usage-limits` for OpenCode.
Upstream's OpenCode driver only reads OpenCode Go.

## Contract

- Discover the plan from OpenCode's resolved provider inventory. A provider qualifies when it
  serves a model whose API URL is `https://api.z.ai` or `https://open.bigmodel.cn` and has a
  resolved API key. The status probe has no model, so it takes the first matching provider and
  prefers `*-coding-plan` providers over pay-as-you-go keys on the same host.
- Send the API key only to the matching HTTPS quota endpoint. Never log it, persist it, or send it
  through T3 Code's client contracts.
- Publish upstream usage windows with stable ids: `zai_5h` (session), `zai_weekly` (weekly), and
  `zai_mcp` (monthly MCP allowance for Web Search, Web Reader, and ZRead calls). A response without a
  coding window publishes nothing.
- The OpenCode status probe merges these windows into the OpenCode Go result. Without a Go key the
  Go read reports `unsupported`, and upstream never applies runtime updates to an unsupported
  snapshot, so a configured Z.AI provider replaces it with the Z.AI windows. A failure on either
  side publishes `probeFailed`, so upstream keeps the windows of the last good probe. That covers an
  unreadable provider list and a lookup and quota read that take over five seconds.
- The windows refresh only when the status probe runs. The orchestration v2 OpenCode adapters have
  no Z.AI code, so there is no refresh between probes, and a Z.AI 429 carries no retry time from
  the plan's reset.

## Surfaces

- Discovery and the probe run on the server, so local, remote, relay, and tunnel connections
  behave the same.
- The windows belong to the OpenCode instance, not to GLM models. `/usage-limits` shows them for
  any OpenCode model, beside any OpenCode Go windows. Usage → Limits shows them on web, desktop, and
  mobile.
- The historical Usage page does not include GLM activity.

## Upstream touch points

- `apps/server/src/provider/zaiUsage.ts` (fork-owned)
- `apps/server/src/provider/Drivers/OpenCodeDriver.ts`: the probe merge, and `withOpenCodeClient`,
  which workspace inventory loading shares

## Verification

`zaiUsage.test.ts` covers window mapping, rejected responses, allowed hosts, where the key is sent,
a probe result taking a live update through upstream's `applyUsageLimitsUpdate`, and failed probes
keeping the last good windows.

## Maintenance

Z.AI's quota response is not part of OpenCode's SDK contract. Keep the decoder permissive about plan
metadata, but require the documented success shape and a coding window before publishing. Retire this
patch when upstream's OpenCode driver reads Z.AI plans itself.
