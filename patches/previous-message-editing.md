# Previous Message Editing

## Summary

The web client lets a user edit an earlier user message by rendering the normal composer inline at that message. Submitting the edit dispatches `thread.checkpoint.revert` to roll the Codex App Server conversation back to the checkpoint before that message, waits until the local projection has pruned the old message and later history, then starts a normal `thread.turn.start` with the edited prompt and attachments.

## Requirements

- Editing is available only for user messages that already have a rollback checkpoint.
- The inline editor reuses `ChatComposer`, including image attachments, model selection, runtime mode, interaction mode, slash commands, and the send button.
- Submitting an edit discards all later conversation history by design.
- If rollback succeeds but the replacement turn fails to start, the edited content is restored into the main composer so the user does not lose it after the original row has been pruned.

## Maintenance Notes

- The server-side rollback primitive lives in the existing `thread.checkpoint.revert` command path and Codex App Server `thread/rollback` adapter call. This patch should not need custom server behavior unless the upstream rollback protocol changes.
- Keep the inline editor on `ChatComposer` rather than adding a second composer implementation. The feature depends on having one composer surface with isolated draft targets.
