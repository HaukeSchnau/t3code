# Provider History Prune Hardening - 2026-07-06

## Goal

- Fix T3/Codex history drift where edited/pruned messages could remain in Codex
  provider context or be re-imported into T3 visible history.
- Cover the concrete incidents observed in T3 threads
  `bbb5af8d-b629-4c7a-a8f6-6932654f7a44` and
  `6f1dc4a0-c458-460b-9bc5-4a83284c5e22`.

## Root Cause

- `thread.history.prune` counted provider turns only from visible message
  `turnId`s, so interrupted user turns with no assistant message could produce
  `prunedTurnIds: []` and skip provider rollback.
- Existing Codex-thread resume imported all provider-side turns not already in
  T3 by message id, so turns beyond T3's retained history boundary could be
  resurrected after a prune.
- Codex rollback updated session status but did not update/persist the
  rollback response's provider thread id as the next resume cursor.

## Implemented Shape

- `ProviderCommandReactor` now collects pruned provider turn ids from visible
  thread references plus `projection_turns.pending_message_id` links.
- `CodexThreadBridge.codexThreadMessages` accepts an optional import boundary;
  `resumeCodexThread` uses the latest T3-retained provider turn for existing
  T3 threads.
- `CodexSessionRuntime.rollbackThread` updates its session `resumeCursor` from
  the rollback response, and `ProviderService.rollbackConversation` persists
  the post-rollback active session binding.

## Verification

- Focused regressions:
  - interrupted/no-assistant prune rollback,
  - pending-message-only provider turn rollback,
  - Codex import boundary does not resurrect provider-only turns,
  - rollback cursor is persisted and reused by the next recovered turn.
- Broader suites run:
  - `ProviderCommandReactor.test.ts`
  - `ProviderService.test.ts`
  - `CodexSessionRuntime.test.ts`
  - `CodexThreadBridge.test.ts`
  - `ProjectionPipeline.test.ts`
  - `threadReducer.test.ts`

## Open Follow-Up

- The `main` JJ bookmark is still conflicted independently of this change.
