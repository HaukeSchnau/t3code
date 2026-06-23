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
- Keep the inline editor on `ChatComposer` rather than adding a second composer implementation. The feature depends on having one composer surface with isolated draft targets.
- The fork-owned implementation lives in `apps/web/src/components/chat/usePreviousMessageEditing.tsx`, `InlineMessageEditor.tsx`, and `previousMessageEditing.ts`. `ChatView` should keep only the hook call and timeline controller wiring so upstream sync conflicts stay small.
- `MessagesTimeline` receives edit eligibility separately from checkpoint revert counts. Do not gate the edit button on `revertTurnCountByUserMessageId`; that map is only for the filesystem checkpoint revert button.
