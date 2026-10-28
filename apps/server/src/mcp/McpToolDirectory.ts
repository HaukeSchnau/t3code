import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Tool } from "effect/ai";
import type { McpServer } from "effect/ai";

type Registration = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];

export interface McpToolEntry {
  readonly tool: Registration["tool"];
  readonly readOnly: boolean;
  /** Reads `McpInvocationContext` from the calling fiber, like a request through `/mcp`. */
  readonly handle: Registration["handle"];
}

/** The tools `/mcp` serves, so in-process callers run the same handlers and checks. */
export class McpToolDirectory extends Context.Service<
  McpToolDirectory,
  {
    readonly record: (registration: Registration) => Effect.Effect<void>;
    readonly find: (name: string) => Effect.Effect<Option.Option<McpToolEntry>>;
  }
>()("t3/mcp/McpToolDirectory") {}

export const layer = Layer.sync(McpToolDirectory, () => {
  const tools = new Map<string, McpToolEntry>();
  return McpToolDirectory.of({
    record: Effect.fn("McpToolDirectory.record")(function (registration) {
      return Effect.sync(() => {
        tools.set(registration.tool.name, {
          tool: registration.tool,
          readOnly: Context.get(registration.annotations, Tool.Readonly),
          handle: registration.handle,
        });
      });
    }),
    find: Effect.fn("McpToolDirectory.find")(function (name) {
      return Effect.sync(() => Option.fromNullishOr(tools.get(name)));
    }),
  });
});
