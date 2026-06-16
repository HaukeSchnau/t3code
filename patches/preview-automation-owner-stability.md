# Preview Automation Owner Stability

## Summary

Keep the desktop preview automation owner stable across routine chat rerenders and right-panel
visibility changes so the main WebSocket transport does not see avoidable owner
`clearOwner`/`reportOwner` churn.

## Requirements

- `ChatView` should derive the active thread reference from the thread's identity fields, not the
  whole mutable thread object.
- `PreviewAutomationOwner` should report ownership only when the effective owner state changes:
  client id, environment id, thread id, tab id, visibility, or automation support.
- Focus events may still force an ownership report because the broker uses `focusedAt` to choose
  between eligible owners.
- Clearing ownership should be reserved for owner teardown or environment/client replacement, not
  for ordinary visibility updates.

## Maintenance

Revisit this patch if upstream changes preview automation owner selection or removes the
client-side owner reporting loop.
