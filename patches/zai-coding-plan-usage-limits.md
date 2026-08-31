# Z.AI Coding Plan usage limits

## Purpose

Show the coding-token allowance from a Z.AI Coding Plan beside the composer when OpenCode is using
the matching GLM model.

## Contract

- Discover eligibility from OpenCode's resolved provider inventory. The selected model must use a
  Z.AI API host, and its provider must expose a resolved API key.
- Send the API key only to the corresponding HTTPS Z.AI quota endpoint. Do not log, persist, or send
  it through T3 Code's client contracts.
- Normalize `TOKENS_LIMIT` entries into the existing provider-neutral usage snapshot. Ignore
  `TIME_LIMIT`, which represents the separate monthly MCP allowance rather than coding tokens.
- Fetch after a matching session starts, after completed turns, and every five minutes while at least
  one identified Z.AI session is alive.
- Share one scheduler across OpenCode sessions. Coalesce requests and allow at most one refresh per
  minute.
- Treat refreshes as best-effort. A failed provider lookup or quota request leaves the last successful
  observation unchanged.
- Show the meter only when OpenCode is selected, the active model is in the `glm-*` family, and the
  model's provider id matches the usage snapshot's `limitId`.
- Reuse the existing rate-limit event, projection, history, forecasting, and stale-state behavior.
  This patch adds no wire schema or database migration.

## Surfaces

- The OpenCode adapter performs provider discovery and refreshes on the server, so local, remote,
  relay, and tunnel connections use the same behavior.
- The shared composer meter covers web and desktop. Mobile does not currently render this meter.
- The historical Usage page remains limited to Codex and Claude activity.

## Verification

- Z.AI normalization tests cover the coding window, optional weekly windows, malformed responses,
  MCP exclusion, and allowed API hosts.
- OpenCode adapter tests cover provider discovery, startup publication, and five-minute polling.
- Composer render tests cover matching GLM models and both provider and model-family mismatches.

## Maintenance

Z.AI's quota response is not part of OpenCode's SDK contract. Keep the response decoder permissive
about optional plan metadata, but require the documented success shape and usable coding windows
before publishing an observation.
