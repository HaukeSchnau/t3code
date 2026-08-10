# Queue and steering reliability investigation

## Goal

Keep the composer and thread lifecycle coherent while users queue multiple follow-ups or dispatch a queued message immediately as steering input.

## Reproduction

- Isolated state: `/tmp/t3-queue-steer-repro-20260810`.
- Real browser against the worktree dev stack.
- A running Codex turn accepted one queued message, but the Queue button remained disabled for the rest of the turn even after the queued tray projected the message.
- Dispatching that queued message with Send now briefly replaced the running composer controls with an idle/connecting state before the same Codex turn completed.
- Ordinary automatic queue drain after a turn completed worked correctly.

## Root causes

- The web local-dispatch acknowledgement watches user messages, turns, sessions, approvals, and errors, but not `queuedMessages`. A queue submission intentionally changes none of the watched running-turn fields, so `isSendBusy` never clears.
- The provider command reactor marks every turn-start request as `starting`, including steering requests sent into an already-running session.
- Codex can steer within the existing provider turn. Its transient ready state therefore has no replacement `turn.started` event, so runtime ingestion can clear the active turn while the steer is pending.

## Resolution

- Treat a projected queue change as authoritative acknowledgement of a local queue submission.
- Release the local composer lock as soon as a queued message is durably accepted, so users can queue another follow-up without waiting for a websocket projection round trip.
- Preserve the running session while the reactor delivers a steering request.
- Preserve the active running turn across a provider ready pulse while that steering start remains pending.

## Verification

- Focused web and server regression tests cover queue acknowledgement, steering delivery into an existing running session, and Codex's same-turn ready pulse.
- In the real web app, queued two messages during a running Codex turn, sent the first immediately as steering input, observed uninterrupted running controls, and watched the second drain automatically afterward without duplication or loss.
