# Codex Turn Pause And Resume

## Requirement

T3 Code users frequently interrupt active work to restart the client, temporarily stop resource
usage, or move between devices. A Codex thread must offer a direct way to continue that interrupted
work without requiring a visible synthetic user message.

Codex can also terminate a turn with `codexErrorInfo: "serverOverloaded"` and `willRetry: false`.
That failure must remain resumable and recover automatically instead of requiring the user to type
a synthetic “continue” message.

## Design

- `thread.turn.resume` targets the latest resumable provider turn by id. Resumable means an
  interrupted Codex turn or a Codex turn that failed because the provider was overloaded. The
  decider rejects stale targets, unrelated failures, and threads that still have active work.
- Resume reuses the durable `thread.turn-start-requested` pipeline with a null message reference and
  `resumedFromTurnId`. Projection turns, checkpoint baselines, receipts, remote connections, and
  multi-client updates therefore follow the normal turn path.
- Provider capabilities declare whether a message-free continuation is supported. Codex uses App
  Server's supported empty `turn/start` input; other providers reject the operation at the adapter
  boundary.
- The interruption itself remains a real provider interruption. Codex records its normal
  interruption context, then Resume starts a new technical provider turn with `input: []`. No user
  message is fabricated in the T3 or Codex transcript.
- Web, desktop, iOS, and Android label the Codex interrupt control Pause and show Resume when the
  composer is empty. Typing a replacement instruction restores Send so steering remains obvious.
- Terminal Codex overload errors retain their structured classification. The session projection
  persists a retry attempt and timestamp so the provider reactor can recover scheduled work after a
  server restart.
- Automatic retries use five attempts with exponential delays of roughly 5, 10, 20, 40, and 80
  seconds plus stable jitter. Meaningful provider progress resets the retry sequence. Manual Resume
  cancels the pending timer and retries immediately; other provider error classes never enter this
  loop.

## Upstream dependency

This behavior depends on Codex App Server accepting an empty `turn/start` input for a resumed
thread. Keep the focused `buildTurnStartParams` and provider continuation tests when updating Codex
protocol support.

## Verification

- Contract decoding and typechecking cover the resume command and nullable continuation link.
- Decider tests cover interrupted and overloaded continuations, automatic retry correlation,
  unrelated errors, and stale-target rejection.
- Provider service and reactor tests cover Codex-only empty continuation and the absence of a new
  user message. Reactor tests also cover due timers and startup recovery from persisted retry state.
- Runtime-ingestion and migration tests cover overload classification, scheduled retry state, and
  persistence.
- Web action tests cover Pause, Resume, typed-instruction precedence, and retry status messaging.
