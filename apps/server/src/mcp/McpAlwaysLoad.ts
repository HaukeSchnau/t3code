import * as Context from "effect/Context";
import { constFalse } from "effect/Function";

/**
 * Claude Code defers MCP tools behind tool search and shows the model only their names. A tool
 * annotated with this is advertised with `_meta["anthropic/alwaysLoad"]`, so its description is in
 * every Claude prompt. Each one costs tokens on every turn.
 */
export const AlwaysLoad = Context.Reference<boolean>("t3/mcp/AlwaysLoad", {
  defaultValue: constFalse,
});
