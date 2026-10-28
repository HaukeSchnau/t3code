# Codex turn pause and resume

## Requirement

People stop Codex to restart the client, free resources, or move to another device, then want it
to carry on. Resuming must not put a synthetic "continue" message into the T3 or Codex
transcript. Upstream's Resume sends a visible "Continue where you left off." message, and only on
web and desktop.

Codex can also end a turn with `codexErrorInfo: "serverOverloaded"` and `willRetry: false` when the
model is at capacity. The fork retries it up to five times, about 5, 10, 20, 40 and 80 seconds
apart, across server restarts. Upstream (#25611) now retries root turns inside `CodexAdapterV2` up
to five times, 2 to 30 seconds apart, within the same run and server process. Its retry row ends
`interrupted`, not `failed`, so the fork's worker and retry notices no longer see those runs. The
fork's retry now only covers overloads upstream does not retry, such as a `/compact` turn.

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
- Web and desktop: `ChatView.tsx` prefers the Codex resumable run, `chat/useComposerResume.ts`
  sends the empty message, `canPauseTurn` goes through `ChatComposer.tsx` and
  `ComposerFooterPrimaryActions` (`chat/ComposerFooterControls.tsx`) to
  `ComposerPrimaryActions.tsx`, and `chat/ChatBannerLane.tsx` gives `ThreadErrorBanner.tsx` the
  retry line. Mobile: `useCodexTurnContinuation.ts` feeds
  `ThreadRouteScreen.tsx`, `ThreadDetailScreen.tsx` (with `CodexOverloadRetryCard.tsx`) and
  `ThreadComposer.tsx`. `AppSymbol.tsx` maps the pause and filled play icons for Android.
- Codex usage-limit stops resume without a message too. The automatic resume at reset
  (`UsageLimitRecoveryWorker.ts`) is upstream's and still sends its visible message.
- Other providers keep Stop and upstream's Resume message. Mobile shows Resume only for Codex.
- Upstream's "Resume queue" (#21473) uses the same composer slot. While the thread's queue is held,
  Resume releases the queue as upstream does; otherwise it continues the paused Codex run without a
  message. Web and mobile follow the same rule.

## Upstream hooks

- `Orchestrator.ts`: the overload clause and the Codex check in manual-continuation validation; the
  skipped user turn item in the immediate-start path.
- `CodexAdapterV2.ts`: the empty-input condition in `startTurn`.
- `runtimeLayer.ts`: the worker beside `UsageLimitRecoveryWorker`.
- `packages/shared/package.json`: the subpath export.
- Web: `ChatView.tsx`, `useComposerResume.ts`, `ChatComposer.tsx`, `ComposerFooterControls.tsx`,
  `ComposerPrimaryActions.tsx`, `ChatBannerLane.tsx`, `ThreadErrorBanner.tsx`.
- Mobile: `ThreadRouteScreen.tsx`, `ThreadDetailScreen.tsx`, `ThreadComposer.tsx`, `AppSymbol.tsx`.

## Removal

Drop the empty-message branches, the Orchestrator user-item skip, and the Pause controls when
upstream resumes Codex without a message on every client. Upstream's in-process retry now covers
root overloads, so the worker, the overload clause and the retry notices in
`packages/shared/src/codexTurnContinuation.ts`, web `ChatView.tsx` and mobile
`CodexOverloadRetryCard.tsx` are due for removal together; the 2026-10-28 sync kept them because
removing them spans four areas. The adapter test documents the dependency on App Server
accepting an empty `turn/start` input.

## Verification

- `packages/shared/src/codexTurnContinuation.test.ts`: resumable runs per provider and stop reason,
  the backoff schedule, exhaustion, and resets after progress or a manual Resume.
- `CodexTurnContinuation.test.ts`: an empty continuation of an interrupted or overloaded Codex run
  starts a run without a user turn item; a non-Codex thread rejects it and keeps the visible
  message.
- `CodexOverloadRetryWorker.test.ts`: the retry fires on schedule and after a restart, and other
  provider errors are left alone.
- `CodexAdapterV2.test.ts`: `turn/start` with `input: []` for a message-free turn. Upstream's
  capacity test covers its own overload retries.
- After a sync, pause and resume a live Codex turn on web and on a phone, and check that no message
  appears.
