# Agents show visuals inline on their own

Agents rarely used `html_render`. From late September to 2026-10-26, Claude sessions on Hauke's hosts called
it in 5 of about 1,100 sessions, while 141 published HTML files instead; Codex called it in 2 of about 300.
Two causes sit in T3:

- Upstream's agent instruction (`orchestrationInstructions.ts`, visuals section) covers only a user who asks
  for a visual. The fork tells agents to render one unasked when a comparison, numbers, a table, a timeline
  or a structure says more than prose, and to write the page to a file once and pass its `path` to
  `html_preview` and `html_render`, so a large page is not written into two tool calls.
- Claude Code defers MCP tools behind tool search and shows the model only their names. `McpAlwaysLoad`
  marks `html_preview` and `html_render`, and `McpHttpServer` advertises them with
  `_meta["anthropic/alwaysLoad"]`, so Claude sees their descriptions. Both schemas cost tokens on every
  Claude turn.

Remove the instruction change if upstream's own guidance gets agents to render unasked. Remove the
always-load marking if Claude Code stops deferring these tools or the cost outweighs the use; recount the
sessions before deciding.
