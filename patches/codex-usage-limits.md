# Codex Usage Limits Footer Meter

## Goal

Show Codex usage limits for the active thread in the composer footer so the current session can surface:

- current usage as a percentage of each available limit window
- when each limit window resets
- whether the current pace is likely to stay within the limit until reset

## Requirements

- The first version is Codex-first and should not change the experience for other providers.
- The UI appears only in the active thread footer, beside the existing context-window meter.
- The server performs a best-effort `account/rateLimits/read` after Codex session startup or resume so usage data can appear immediately.
- The server also performs a best-effort periodic `account/rateLimits/read` refresh during active Codex sessions so stale limits self-correct even if push updates are missed.
- A failed or missing `account/rateLimits/read` response must never block or degrade session startup.
- A failed periodic refresh must never interrupt or degrade an active session.
- Live `account/rateLimits/updated` notifications continue to refresh the displayed usage after the initial fetch.
- Rate-limit data is normalized into thread activities so the existing thread subscription path remains the only transport to the web app.
- The footer popover shows reset timing using both relative and absolute labels when possible.
- The footer popover includes a pace heuristic based on projected percentage at reset.
- The pace heuristic is a forecast derived from percentage usage, not a guarantee of remaining quota.
- The implementation stays narrowly scoped and avoids introducing a new global dashboard or account-level cache.

## Non-Goals

- No global environment-level or settings-level usage dashboard.
- No provider-agnostic UI rollout for Claude, Cursor, or OpenCode in this patch.
- No raw quota-unit accounting beyond the percentages exposed by Codex.
- No changes to WebSocket contracts, orchestration RPC methods, or provider model-selection flows.
