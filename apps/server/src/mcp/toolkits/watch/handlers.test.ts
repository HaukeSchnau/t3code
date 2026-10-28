import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as AgentWatches from "../../../watches/AgentWatches.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WatchHandlers from "./handlers.ts";
import { WatchToolkit } from "./tools.ts";

const threadId = ThreadId.make("watch-tool-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("watch-tool-environment"),
  requestNamespace: "watch-tool-session",
  thread: {
    threadId,
    providerSessionId: "watch-tool-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "watch-tool", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "watch-tool", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const watch: AgentWatches.AgentWatch = {
  watchId: AgentWatches.WatchId.make("watch-1"),
  label: null,
  source: { type: "command", command: "tail -f log", cwd: "/work" },
  state: "open",
  closeReason: null,
  deadlineAt: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  closedAt: null,
};

it.effect("routes each t3_watch action and asks for the field it needs", () => {
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (args: Record<string, unknown>) =>
      server
        .callTool({ name: "t3_watch", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    expect((yield* call({ action: "list", includeClosed: true })).structuredContent).toEqual({
      watches: [],
    });
    const missing = yield* call({ action: "create" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]).toMatchObject({ text: expect.stringContaining("source") });
    expect((yield* call({ action: "cancel", watchId: "watch-1" })).structuredContent).toMatchObject(
      { watchId: "watch-1" },
    );
    expect(calls).toEqual(["list:true", "cancel:watch-1"]);
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(WatchToolkit, WatchHandlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(AgentWatches.AgentWatches)({
            list: (input) =>
              Effect.sync(() => {
                calls.push(`list:${input.includeClosed}`);
                return [];
              }),
            cancel: (input) =>
              Effect.sync(() => {
                calls.push(`cancel:${input.watchId}`);
                return watch;
              }),
          }),
        ),
      ),
    ),
  );
});
