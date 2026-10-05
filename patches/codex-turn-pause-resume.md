# Codex turn pause and resume

## Requirement

People stop Codex to restart the client, free resources, or move to another device, then want it
to carry on. Resuming must not put a synthetic "continue" message into the T3 or Codex
transcript. Upstream's Resume sends a visible "Continue where you left off." message, and only on
web and desktop.

Codex can also end a turn with `codexErrorInfo: "serverOverloaded"` and `willRetry: false` when the
model is at capacity. Upstream shows it as an ordinary provider error. The fork retries it up to
five times, about 5, 10, 20, 40 and 80 seconds apart, across server restarts.

## Implementation

- `packages/shared/src/codexTurnContinuation.ts` holds the rules the server, web and mobile share:
  which run Codex can resume, whether Codex is working, the retry state, and the banner text.
- Resume uses upstream's `message.dispatch` with `manualContinuationOfRunId` and an empty message.
  `Orchestrator.ts` also accepts overload failures as a source, rejects an empty continuation unless
  the source run is Codex on the thread's current instance, and emits no user turn item for it. The
  run keeps an empty conversation message because every v2 run points at one.
- `CodexAdapterV2.ts` sends `turn/start` with `input: []` for an empty message, the same request
  upstream uses for restart continuations.
- `CodexOverloadRetryWorker.ts` runs on upstream's shared scheduler. Nothing about the sequence is
  stored. Each retry's message id is `codex-overload-retry:<failed run id>`, which links it to the
  run it continues and makes the dispatch idempotent. The attempt number is the length of that chain
  of overloaded runs, and the wait counts from the failed run's `completedAt`. A retry with agent
  output, or any continuation the user started, begins a new sequence. Other errors never match.
- Web and desktop: `ChatView.tsx` prefers the Codex resumable run, sends the empty message, passes
  `canPauseTurn` through `ChatComposer.tsx` to `ComposerPrimaryActions.tsx`, and gives
  `ThreadErrorBanner.tsx` the retry line. Mobile: `useCodexTurnContinuation.ts` feeds
  `ThreadRouteScreen.tsx`, `ThreadDetailScreen.tsx` (with `CodexOverloadRetryCard.tsx`) and
  `ThreadComposer.tsx`. `AppSymbol.tsx` maps the pause and filled play icons for Android.
- Codex usage-limit stops resume without a message too. The automatic resume at reset
  (`UsageLimitRecoveryWorker.ts`) is upstream's and still sends its visible message.
- Other providers keep Stop and upstream's Resume message. Mobile shows Resume only for Codex.

## Upstream hooks

- `Orchestrator.ts`: the overload clause and the Codex check in manual-continuation validation; the
  skipped user turn item in the immediate-start path.
- `CodexAdapterV2.ts`: the empty-input condition in `startTurn`.
- `runtimeLayer.ts`: the worker beside `UsageLimitRecoveryWorker`.
- `packages/shared/package.json`: the subpath export.
- Web: `ChatView.tsx`, `ChatComposer.tsx`, `ComposerPrimaryActions.tsx`, `ThreadErrorBanner.tsx`.
- Mobile: `ThreadRouteScreen.tsx`, `ThreadDetailScreen.tsx`, `ThreadComposer.tsx`, `AppSymbol.tsx`.

## Removal

Drop the empty-message branches, the Orchestrator user-item skip, and the Pause controls when
upstream resumes Codex without a message on every client. Drop the worker and the overload clause
when upstream retries `serverOverloaded`. The adapter test documents the dependency on App Server
accepting an empty `turn/start` input.

## Verification

- `packages/shared/src/codexTurnContinuation.test.ts`: resumable runs per provider and stop reason,
  the backoff schedule, exhaustion, and resets after progress or a manual Resume.
- `CodexTurnContinuation.test.ts`: an empty continuation of an interrupted or overloaded Codex run
  starts a run without a user turn item; a non-Codex thread rejects it and keeps the visible
  message.
- `CodexOverloadRetryWorker.test.ts`: the retry fires on schedule and after a restart, and other
  provider errors are left alone.
- `CodexAdapterV2.test.ts`: `turn/start` with `input: []` and the `serverOverloaded` failure code.
- After a sync, pause and resume a live Codex turn on web and on a phone, and check that no message
  appears.
