# Codex Usage Limits Meter

## Goal

Show Codex usage limits in the active thread composer footer, next to the context-window meter,
with reset timing and a simple forecast of whether current usage will last until reset.

## Source Context

- Backfilled from the current fork delta against `main@upstream`.
- Session archive thread `019db5f0-049d-7980-85cf-aa286eed4971` recorded the original plan:
  Codex-first, non-disruptive footer placement, reuse thread activity, and document requirements
  in `patches/*.md`.
- Session archive thread `019e8eef-d840-7370-9e38-ec5ab5c226b9` recorded the restore plan after
  an upstream sync: restore the feature from `main-before-upstream-20260529`, keep it Codex-only,
  and avoid new WebSocket, RPC, database, or contract APIs.

## Requirements

- Render only for Codex-backed active threads and only when a valid usage-limits snapshot exists.
- Place the meter in the composer footer beside `ContextWindowMeter`; do not add a dashboard,
  environment badge, or header treatment.
- Fetch usage limits best-effort after Codex session start/resume.
- Refresh usage limits every 5 minutes while the Codex runtime session is alive.
- Convert successful `account/rateLimits/read` results into the existing
  `account/rateLimits/updated` provider notification path.
- Select the initial Codex bucket in this order:
  1. `rateLimitsByLimitId.codex`
  2. legacy `rateLimits`
  3. the sole available `rateLimitsByLimitId` entry when exactly one exists
- Swallow/log refresh failures. Usage-limit failures must never block session startup, active
  turns, reconnects, or shutdown.
- Project provider notifications into thread activity kind `account.rate-limits.updated` with
  normalized fields: `limitId`, `limitName`, `planType`, `rateLimitReachedType`, `credits`,
  `primary`, and `secondary`.
- Each window should normalize `usedPercent`, `resetsAt`, and `windowDurationMins`.
- When Codex supplies a 7d usage limit as `individualLimit` with `remainingPercent`, normalize it
  into the `secondary` display window as `100 - remainingPercent`. Use it when `secondary` is
  absent or when `secondary.usedPercent` is still the stale zero value.
- Treat numeric `resetsAt` values defensively: large epoch values are milliseconds, smaller epoch
  values are seconds.
- Ignore malformed or empty usage-limit payloads instead of appending noisy activities.
- Hide usage-limit activity from the work-log/timeline presentation, like context-window updates.
- Derive display state on the client from existing thread activity, including:
  - duration labels
  - relative and absolute reset labels
  - elapsed window percentage
  - projected usage at reset
  - status: `ok`, `atRisk`, `reached`, or `unknown`
- Use `projectedPercentAtReset = usedPercent / elapsedPercent * 100` as the forecast heuristic.
- Discount expected usage during local sleep hours from 02:00 to 07:00.
- Weight weekly-window weekend time at 25% of weekday usage.
- Keep the UI compact by default, using muted styling for `ok`, amber for `atRisk`, and red for
  `reached`.

## Upstream Touch Points

- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/ProviderUsageLimitsProjection.ts`
- `apps/web/src/lib/usageLimits.ts`
- `apps/web/src/components/chat/UsageLimitsMeter.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/ChatView.tsx`

## Non-Goals

- No provider-agnostic quota framework beyond the normalized activity shape.
- No new WebSocket, RPC, database, or public contract APIs.
- No global quota dashboard.
- No raw quota-unit forecast; Codex currently exposes percentages, so the forecast is necessarily
  heuristic.

## Verification

- `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- `apps/web/src/lib/usageLimits.test.ts`
- `apps/web/src/components/chat/ChatComposerUsageLimitsMeterSlot.test.tsx`
- Required focused gates: server/web package typechecks and the listed tests.
