# Codex Tool Context Expansion

## Goal

Give T3 Code richer, inspectable context for Codex tool activity in the existing work log so tool rows can show:

- what tool actually ran
- the important parameters and inputs
- the output or result
- file diffs for file edits when available
- the exact raw payload behind a secondary disclosure

## Requirements

- The patch is Codex-first and should stay minimally disruptive for other providers.
- The work-log timeline remains the primary surface; no new dedicated inspector route or panel is added.
- Tool rows stay compact by default and expand in place only when richer detail is available.
- Expanded rows should present human-readable sections before any raw payload view.
- The raw payload must be hidden by default behind a secondary disclosure inside the expanded row.
- Existing `activity.payload.data` is the only source of rich tool context in v1.
- No WebSocket contract, orchestration schema, or server RPC changes are introduced for this patch.
- The implementation should stay mostly inside `apps/web`.
- Codex command execution rows should show command input and output when available.
- Codex file-change rows should show changed files and inline diff previews when available.
- Codex dynamic tool calls should prefer the actual tool name over generic labels like `Tool call`.
- Codex MCP tool calls should surface the MCP server/tool identity, arguments, and result or error.
- If a file-change row still has a `turnId`, the expanded detail should reuse the existing turn-diff open action for a full diff handoff.
- Rows without meaningful extra detail should continue to render as compact non-expanded work-log entries.

## Defaults Chosen

- Codex-first
- expandable rows instead of always-inline detail
- human-readable detail plus a collapsed raw JSON inspector
- no new transport or orchestration changes for v1
- no live streaming terminal-output panel in this patch

## Non-Goals

- No provider-agnostic redesign for Claude, Cursor, or OpenCode.
- No new server-side persistence for streamed command/file-change output.
- No new thread activity types, RPC methods, or websocket message shapes.
- No attempt to build a full terminal transcript viewer inside the chat timeline.
- No migration of existing diff or checkpoint UX away from the current turn-diff route.
