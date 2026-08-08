# Disabled Agent Browser Tools

## Goal

Do not expose T3 Code's collaborative browser tools to agents while the preview host is not
reliably available in this fork. Advertising `preview_status` and `preview_open` causes agents to
spend time probing a capability that cannot be used in many environments.

## Requirements

- The production MCP server must not register the `preview_*` toolkit.
- Codex collaboration-mode instructions must not advertise or prioritize T3 Code browser tools.
- Thread orchestration MCP tools remain registered and documented.
- The preview toolkit implementation stays dormant so focused tests keep covering it and the
  feature can be restored without reconstructing the browser protocol.
- This patch does not remove the user-facing preview panel or the read-only workspace file viewer.

## Upstream Touch Points

- `apps/server/src/mcp/McpHttpServer.ts`
- `apps/server/src/provider/CodexDeveloperInstructions.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`

## Re-enable When

Re-enable the toolkit only when preview availability can be represented truthfully at MCP tool
discovery time, or when every supported environment has an automation-capable preview host.

## Verification

- Run the focused Codex session runtime and MCP server tests.
- Typecheck the server package.
- Confirm generated collaboration-mode instructions contain no `preview_status` or `preview_open`.
