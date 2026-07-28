import { type EnvironmentId, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "threads";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export class McpCapabilityUnavailableError extends Error {
  readonly capability: McpCapability;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;

  constructor(input: {
    readonly capability: McpCapability;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly providerInstanceId: ProviderInstanceId;
  }) {
    super(`MCP credential does not grant the ${input.capability} capability.`);
    this.name = "McpCapabilityUnavailableError";
    this.capability = input.capability;
    this.environmentId = input.environmentId;
    this.threadId = input.threadId;
    this.providerSessionId = input.providerSessionId;
    this.providerInstanceId = input.providerInstanceId;
  }
}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* Effect.fail(
      new McpCapabilityUnavailableError({
        capability,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      }),
    );
  }
  return invocation;
});
