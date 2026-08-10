# Direct Codex title generation

## Goal

- Replace process-per-title `codex exec` calls with a direct Codex Responses request using the
  selected provider instance's ChatGPT authentication.
- Preserve the existing CLI implementation as a compatibility fallback.
- Verify the full automatic-title flow with real Codex auth in an isolated dev app, then push and
  deploy the fork.

## Design

- Keep the existing Effect `TextGeneration` service as the application boundary.
- Use `@openai-oauth/core` plus `@openai-oauth/local` only inside the Codex adapter.
- Enable the direct path only for text-only thread titles; image-backed titles retain the CLI path.
- Read the effective `CODEX_HOME/auth.json` with automatic refresh disabled.
- On HTTP 401, ask a short-lived Codex app-server `account/read` request with
  `refreshToken: true` to refresh managed credentials, then retry the direct request once.
- Never let the JavaScript OAuth library rotate Codex's refresh token independently.
- Fall back to `codex exec` for missing/file-inaccessible auth, unsupported auth stores, transport
  incompatibility, non-success responses, malformed structured output, or failed managed refresh.

## Current step

- Commit and push the refreshed Nix dependency hashes, advance the infrastructure pin, deploy
  `srv-2`, and verify service health.

## Implementation status

- Added the `@openai-oauth/core` and `@openai-oauth/local` adapter boundary.
- Added direct structured title generation with a 30-second timeout.
- Added one managed-refresh retry after HTTP 401 and reset the transport so a failed model-catalog
  lookup cannot poison the retry.
- Retained CLI generation for images and as the fallback for every direct-path failure.
- Extracted reusable initialized app-server startup from the existing provider probe.

## Verification plan

- Unit tests for direct success, request shape, retry after managed refresh, malformed response,
  and CLI fallback.
- Focused server tests, server typecheck, scoped format/lint, and deploy-lock verification.
- Live direct generation with the configured GPT-5.6 Luna selection and real auth.
- Isolated dev-app automatic-title creation and later refresh in a controlled browser.
- Push T3 Code `main`, advance the `~/infra` pin, deploy `srv-2`, and verify service health.

## Verification status

- 29 focused Codex generation/provider tests pass, including direct success, Responses Lite,
  managed-refresh retry, malformed-response fallback, and image-backed CLI generation.
- 136 integrated automatic-title/provider/orchestration tests pass.
- Server typecheck and scoped lint/format pass; only pre-existing Effect suggestions remain.
- Canonical and deployment lockfiles were regenerated with pnpm 11.10.0; deterministic lock check
  passes.
- A direct real-auth GPT-5.6 Luna probe returned `Fast GPT-5.6 Thread Titles` in about 4.0 seconds.
- Isolated browser E2E generated `WebSocket Reconnection Failures`, then refreshed it to
  `Cool-Kitchen Sourdough Schedule` after a complete topic shift.
- Negative-control browser E2E set the isolated Codex binary to `/bin/false`, ran the conversation
  through Claude, and still generated `Migrate REST Polling to SSE` via the real Codex auth. This
  proves the live title did not use `codex exec`. The binary setting was restored afterward.
- The complete `packages.aarch64-linux.t3code` Nix artifact builds after refreshing the server and
  runtime pnpm fixed-output hashes for the new OAuth dependencies.

## Isolation incident

- The first supervised dev start unexpectedly resolved its base directory to the shared `~/.t3`
  instead of a worktree-local directory. It ran for about 40 seconds without browser traffic and
  reported migration 52 before being stopped by its exact service name.
- Migration 52 only adds the nullable `projection_threads.title_mode` column and its migration row;
  no user commands were sent. The subsequent dev run used the explicitly verified isolated path
  `.t3/title-direct-dev`.

## Deployment status

- The feature commit is on fork `main`.
- The first infrastructure evaluation exposed stale pnpm fixed-output hashes; both are now repaired
  and the production T3 package builds. Infrastructure repinning and host activation remain.
