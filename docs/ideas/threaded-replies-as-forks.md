# Threaded Replies as Forks

## Status

Idea only. Not implemented.

## Summary

Rethink thread forking as a visible, conversation-native reply experience. Instead of creating a
separate thread whose relationship to the source thread is hard to see, let users reply to a specific
message in the conversation history. Under the hood, that reply can still create or resume a forked
thread, but the UI should represent the result as a nested conversation tree.

The target mental model is closer to Reddit or Facebook comments: each message can have replies,
each reply can have its own replies, and the user can respond exactly at the point in history where
the new direction belongs.

## Current Problem

Forking currently creates a new thread based on the source thread, but the relationship between the
fork and its origin is not visible enough in the UI. That makes it hard to understand which message
caused a fork, how sibling forks relate to each other, and where useful work continued after a
branch.

## Desired Experience

- Replace or reframe the current message-level fork affordance as a reply action.
- Show replies nested below the message they respond to, forming a visible message tree.
- Allow multiple replies to the same historical message, with each reply becoming a sibling branch.
- Allow replies to replies, so deeper exploration remains attached to the relevant context.
- Keep the underlying implementation compatible with forked threads where practical.
- Let the user focus a reply subtree and treat it as the active working thread when useful work moves
  there.
- Preserve the ability to understand the original trunk and all branches without requiring users to
  mentally map separate thread records.

## Focus Model

The original thread should not permanently own the idea of "main". A reply branch may become the
place where the real work continues. The UI needs a way to focus a subtree so the selected branch can
temporarily behave like the primary thread while the broader tree remains recoverable.

Possible focus behaviors:

- Open a reply subtree in a focused view with enough ancestry visible to preserve context.
- Let users promote or pin a branch as the active path for a project.
- Show breadcrumbs or a compact branch path when focused inside a nested reply.
- Make it easy to return to the full conversation tree.

## Implementation Notes

- Treat the reply action as a fork operation at the protocol/storage boundary.
- Store enough parentage metadata to render branch relationships from the source message, not only
  from the source thread.
- Prefer naming that matches the user-facing model, likely "reply", while keeping "fork" as the
  lower-level implementation concept.
- Consider whether thread lists should show only top-level conversations, focused branches, or both.
- Consider how branch focus interacts with session resume, provider state, queued messages, and
  partial streams.

## Open Questions

- What is the best user-facing term: reply, branch, follow-up, continuation, or something else?
- Should focused subtrees have their own URL/deep link, or should deep links always resolve to the
  full tree plus a selected branch?
- How should notifications, unread state, or activity indicators work across sibling replies?
- Should users be able to collapse, archive, or hide individual reply branches?
- How much of the tree should be rendered at once for large conversations?

## Verification Ideas

- Prototype the conversation tree with real fork metadata from existing sessions.
- Test whether users can explain where a reply branch came from without opening a separate thread
  list.
- Stress-test focus switching during long-running agent turns, reconnects, and partial streams.
