# Inline replies

## Summary

The web client lets users respond to an assistant paragraph, list item, or selected text directly
inside the assistant message. Authored replies and the optional main-composer note are formatted as
one ordinary user message when sent.

## Requirements

- Assistant messages keep their existing Markdown typography and spacing when no reply is open.
- A paragraph/list-item reply affordance appears only while that block is hovered. Selecting text
  exposes a small contextual Reply action.
- Open editors identify their exact selected text or say `Whole paragraph`. Selection replies keep
  a quiet source highlight, and paragraph replies keep a small source indicator.
- The existing main composer remains the only send control. Inline replies enable it even when its
  own prompt is empty (`hasExternalSendableContent`), and its text acts as an optional overall note.
- `ChatView.tsx`'s send path formats the replies with `formatInlineReplyPrompt` for single-model,
  multi-model, and plan follow-up sends. A successful send clears them, and a failed send restores
  them. No provider or wire-contract specialization is allowed.

## Maintenance notes

- `chat/inlineReplies.ts` owns the external draft store and prompt formatting. Per-block
  subscriptions keep editor keystrokes from replacing Markdown renderers or disturbing other blocks.
- Inline replies are persisted as part of `composerDraftStore`'s per-thread draft. Creating a routed
  editor restores that slice, and every inline edit writes it back through the composer's existing
  debounced local-storage path.
- `MessagesTimeline.tsx` renders `AssistantInlineReplies` in place of `ChatMarkdown` when the
  store exists. Forward every prop upstream adds to the `ChatMarkdown` call beside it, such as
  `onRunShellCommand`.
- `ChatMarkdown.renderBlock` is the narrow upstream seam. Preserve its default output when no
  decorator is supplied; do not fork or replace the Markdown renderer.
- The transparent hit target for each block affordance is always mounted in the adjacent gutter; its
  icon becomes visible when either the block or that target is hovered. Text selection follows the
  document `selectionchange` event. Whole-block browser selections may end at the next block
  boundary and must be normalized back to the source block.
- The feature ships on the web client and therefore the Electron desktop client. The React Native
  mobile timeline remains unchanged until it has a native text-selection interaction.
