# Codex Turn Pause And Resume

## Requirement

T3 Code users frequently interrupt active work to restart the client, temporarily stop resource
usage, or move between devices. A Codex thread must offer a direct way to continue that interrupted
work without requiring a visible synthetic user message.

## Design

- `thread.turn.resume` targets the latest interrupted provider turn by id. The decider rejects stale
  targets and threads that still have active work.
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

## Upstream dependency

This behavior depends on Codex App Server accepting an empty `turn/start` input for a resumed
thread. Keep the focused `buildTurnStartParams` and provider continuation tests when updating Codex
protocol support.

## Verification

- Contract decoding and typechecking cover the resume command and nullable continuation link.
- Decider tests cover valid continuation and stale-target rejection.
- Provider service and reactor tests cover Codex-only empty continuation and the absence of a new
  user message.
- Web action tests cover Pause, Resume, and typed-instruction precedence.
