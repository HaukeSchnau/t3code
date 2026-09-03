# Previous Message Editing

## Summary

The web client lets a user edit an earlier user message by rendering the normal composer inline at that message. Submitting the edit dispatches `thread.history.prune`, rolls the provider conversation back by the number of provider turns being discarded, waits until the local projection has pruned the old message and later history, then starts a normal `thread.turn.start` with the edited prompt and attachments.

## Requirements

- Editing is available for prior server-thread user messages without requiring filesystem checkpoints.
- The inline editor reuses `ChatComposer`, including image attachments, model selection, runtime mode, interaction mode, slash commands, and the send button.
- Submitting an edit discards all later conversation history by design.
- Editing does not restore or mutate workspace files. The separate checkpoint revert button remains responsible for filesystem rollback when checkpoint data exists.
- If history pruning succeeds but the replacement turn fails to start, the edited content is restored into the main composer so the user does not lose it after the original row has been pruned.

## Maintenance Notes

- The server-side edit primitive is `thread.history.prune` -> `thread.history-prune-requested` -> `thread.history.prune.complete` -> `thread.history-pruned`. The provider reactor uses `ProviderService.rollbackConversation` for conversation context only; it must not restore checkpoint refs or workspace files.
- Provider rollback count must be derived from all durable provider-turn references at or after the edited user message, not only assistant messages. The reactor intentionally combines visible thread references with hidden `projection_turns.pending_message_id` links so interrupted/no-output turns still roll back provider context.
- Codex resume/import must treat the T3 projection as authoritative for existing T3 threads. When importing provider-side Codex history into an existing T3 thread, only import through the latest provider turn T3 still retains; later Codex turns may be provider-side leftovers from a prune/rollback race and must not be resurrected into visible history.
- Rollback must persist the provider's post-rollback resume cursor before the next recovered turn. Legacy Codex threads use `thread/rollback`, which can return a new provider thread id. Paginated Codex threads reject that method, so `CodexSessionRuntime` pages newest-first through `thread/turns/list`, converts the rollback count to a `beforeTurnId`, and calls `thread/revert`. Both paths update `resumeCursor`, and `ProviderService.rollbackConversation` persists the active session state before the next recovered turn.
- Keep the inline editor on `ChatComposer` rather than adding a second composer implementation. The feature depends on having one composer surface with isolated draft targets.
- The fork-owned implementation lives in `apps/web/src/components/chat/usePreviousMessageEditing.tsx`, `InlineMessageEditor.tsx`, and `previousMessageEditing.ts`. `ChatView` should keep only the hook call and timeline controller wiring so upstream sync conflicts stay small.
- `MessagesTimeline` receives edit eligibility separately from checkpoint revert counts. Do not gate the edit button on `revertTurnCountByUserMessageId`; that map is only for the filesystem checkpoint revert button.
