# Resume-turn reliability investigation

## Goal

Make Codex pause/resume reliably continue unfinished work without adding a user-visible message.

## Root cause

- T3 dispatched a continuation turn with `continuation: true` and no input.
- Codex accepts an empty turn, but its behavior is task-dependent. In the live failing thread it replied that interruption had succeeded and ended instead of continuing the watch task.
- The transport and orchestration state were healthy: a new provider turn started and completed. The missing continuation intent was the defect.

## Fix

- Codex continuation turns now receive an adapter-owned hidden prompt instructing the agent to resume the next unfinished action without commenting on the interruption or repeating completed work.
- Provider capability naming now describes prompt-backed continuation instead of claiming empty-input continuation.
- T3 still emits no user message for resume, so the chat transcript remains unchanged.

## Verification

- Focused tests: Codex adapter, provider service, and provider command reactor (107 passed).
- Focused lint passed for all changed TypeScript files.
- Isolated web app reproduction confirmed pause and resume through the real UI.
- Before the fix, the live thread's empty continuation stopped after saying interruption succeeded.
- After the fix, an interrupted `sleep 300` task checked whether the old process survived and restarted the unfinished command.
- Server package typecheck remains blocked by unrelated existing errors in `CodexThreadRpcWorkflow.test.ts`.

## Remaining work

- Commit and push the T3 change.
- Advance the infra T3 flake input, apply `srv-2`, and verify the deferred restart.
