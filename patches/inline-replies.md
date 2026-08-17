# Inline Replies

## Summary

The web client lets users respond to an assistant paragraph, list item, or selected text directly
inside the assistant message. Authored replies and the optional main-composer note are formatted as
one ordinary user turn when sent.

## Requirements

- Assistant messages keep their existing Markdown typography and spacing when no reply is open.
- A paragraph/list-item reply affordance appears only while that block is hovered. Selecting text
  exposes a small contextual Reply action.
- Open editors identify their exact selected text or say `Whole paragraph`; selection replies keep a
  quiet source highlight and paragraph replies keep a small source indicator.
- The existing main composer remains the only send control. Inline replies enable it even when its
  own prompt is empty, and its text acts as an optional overall note.
- Sending, queueing, validation, retry restoration, and provider delivery continue through the
  normal thread-turn submission path. No provider or wire-contract specialization is allowed.

## Maintenance Notes

- `chat/inlineReplies.ts` owns the external draft store and prompt formatting. Per-message
  subscriptions keep editor keystrokes from rerendering the whole virtualized timeline.
- `ChatMarkdown.renderBlock` is the narrow upstream seam. Preserve its default output when no
  decorator is supplied; do not fork or replace the Markdown renderer.
- Inline reply state is intentionally authoring-local and resets when the routed thread changes.
- The feature currently ships on the web client and therefore the Electron desktop client. The
  React Native mobile timeline remains unchanged until it has a native text-selection interaction.
