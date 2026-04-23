# Thread Scratchpad Right Panel

## Goal

Add a lightweight thread scratchpad so users can keep side notes without interrupting the agent.

## Requirements

- Web-only, minimal, non-disruptive patch
- Scratchpad lives in the existing right-panel lane
- Scratchpad is per-thread and local-only
- Scratchpad never affects agent context unless explicitly appended
- Scratchpad and plan share one lane; only one can be open at a time
- Reuse inline sidebar vs sheet behavior based on existing right-panel media query
- Append action adds notes to the composer without sending
- Scratchpad supports markdown preview without introducing server-side note handling
- Users can append a selected portion of the scratchpad without appending the whole note
- Scratchpad survives reloads
- Scratchpad follows draft-thread promotion into the real server thread
- No server, contracts, settings, or RPC changes

## Defaults Chosen

- shared right panel
- per-thread persistence
- explicit append action
- markdown preview rather than a full rich-text editor
- selected-text append with a keyboard shortcut
- no auto-clear after append
- no export/share/save-to-workspace behavior

## Non-Goals

- no synced notes
- no global notebook
- no project-wide notes
- no implicit prompt context
- no redesign of plan panel infrastructure beyond shared-lane state
- no new command palette or slash-command entry
