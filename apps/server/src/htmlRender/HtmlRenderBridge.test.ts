import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer, Tool } from "effect/ai";

import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as McpToolDirectory from "../mcp/McpToolDirectory.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { JjToolkit } from "../mcp/toolkits/jj/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../mcp/toolkits/worktree/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as HtmlRenderBridge from "./HtmlRenderBridge.ts";

const threadId = ThreadId.make("html-render-bridge-thread");
const renderId = createAttachmentId(threadId, "html")!;
const foreignRenderId = createAttachmentId("another-thread", "html")!;
const viewer = { sessionId: "session-hauke" };

const shell = McpToolAccessTestkit.liveThreadShell(threadId, {
  runtimeMode: "approval-required",
  interactionMode: "plan",
  activeRunId: null,
});

const database = NodeSqliteClient.layer({ filename: ":memory:" });

const layerEnvironment = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("html-render-bridge-environment")),
});

const layerBridge = HtmlRenderBridge.layer.pipe(
  Layer.provideMerge(McpToolDirectory.layer),
  Layer.provide(layerEnvironment),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(id === threadId ? shell : null),
    }),
  ),
  Layer.provideMerge(database),
);

const recordTool = (input: {
  readonly name: string;
  readonly readOnly: boolean;
  readonly handle: (payload: unknown) => Effect.Effect<McpSchema.CallToolResult, never, never>;
}) =>
  Effect.flatMap(McpToolDirectory.McpToolDirectory, (directory) =>
    directory.record({
      tool: new McpSchema.Tool({
        name: input.name,
        inputSchema: { type: "object", properties: { threadId: { type: "string" } } },
      }),
      annotations: Context.make(Tool.Readonly, input.readOnly),
      handle: input.handle,
    }),
  );

const okResult = (structuredContent: unknown) =>
  new McpSchema.CallToolResult({ content: [], structuredContent });

it.layer(layerBridge)("HtmlRenderBridge", (it) => {
  it.effect("refuses a render that another thread published", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const bridge = yield* HtmlRenderBridge.HtmlRenderBridge;
      const refused = yield* bridge
        .getState({ threadId, renderId: foreignRenderId })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("render-not-found");
      const call = yield* bridge
        .callTool(
          { threadId, renderId: foreignRenderId, name: "t3_thread_list", arguments: {} },
          viewer,
        )
        .pipe(Effect.flip);
      expect(call.reason).toBe("render-not-found");
    }),
  );

  it.effect("keeps one state map per render and drops it when emptied", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const bridge = yield* HtmlRenderBridge.HtmlRenderBridge;
      yield* bridge.setState({ threadId, renderId, state: { answer: "B" } });
      expect(yield* bridge.getState({ threadId, renderId })).toEqual({ answer: "B" });
      yield* bridge.setState({ threadId, renderId, state: {} });
      expect(yield* bridge.getState({ threadId, renderId })).toEqual({});
    }),
  );

  it.effect("asks before a tool that changes things, then runs it within the thread's modes", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<
        ReadonlyArray<{ payload: unknown; scope: McpInvocationContext.McpInvocationScope }>
      >([]);
      yield* recordTool({
        name: "t3_thread_send",
        readOnly: false,
        handle: (payload) =>
          Effect.serviceOption(McpInvocationContext.McpInvocationContext).pipe(
            Effect.flatMap((scope) =>
              Ref.update(calls, (all) =>
                scope._tag === "Some" ? [...all, { payload, scope: scope.value }] : all,
              ),
            ),
            Effect.as(okResult({ sequence: 1 })),
          ),
      });
      const bridge = yield* HtmlRenderBridge.HtmlRenderBridge;
      const input = { threadId, renderId, name: "t3_thread_send", arguments: { text: "hi" } };

      expect(yield* bridge.callTool(input, viewer)).toMatchObject({
        _tag: "ConfirmationRequired",
      });
      expect(yield* Ref.get(calls)).toEqual([]);

      expect(yield* bridge.callTool({ ...input, confirmed: true }, viewer)).toEqual({
        _tag: "Completed",
        isError: false,
        value: { sequence: 1 },
      });
      const [call] = yield* Ref.get(calls);
      expect(call?.payload).toEqual({ threadId, text: "hi" });
      expect(call?.scope.thread).toBeUndefined();
      expect(call?.scope.client).toMatchObject({
        sessionId: viewer.sessionId,
        access: "approval-required",
        interactionMode: "plan",
      });
    }),
  );

  it.effect("refuses tools outside the page list even though /mcp serves them", () =>
    Effect.gen(function* () {
      yield* recordTool({
        name: "t3_project_delete",
        readOnly: false,
        handle: () => Effect.succeed(okResult({})),
      });
      const bridge = yield* HtmlRenderBridge.HtmlRenderBridge;
      const refused = yield* bridge
        .callTool(
          { threadId, renderId, name: "t3_project_delete", arguments: {}, confirmed: true },
          viewer,
        )
        .pipe(Effect.flip);
      expect(refused.reason).toBe("tool-not-allowed");
    }),
  );

  it.effect("limits how often one render calls tools", () =>
    Effect.gen(function* () {
      yield* recordTool({
        name: "t3_queue_list",
        readOnly: true,
        handle: () => Effect.succeed(okResult({ queue: [] })),
      });
      const bridge = yield* HtmlRenderBridge.HtmlRenderBridge;
      const call = bridge.callTool(
        {
          threadId,
          renderId: createAttachmentId(threadId, "html")!,
          name: "t3_queue_list",
          arguments: {},
        },
        viewer,
      );
      yield* Effect.repeat(call, { times: 29 });
      expect((yield* Effect.flip(call)).reason).toBe("rate-limited");
      yield* TestClock.adjust("1 minute");
      expect(yield* call).toMatchObject({ _tag: "Completed" });
    }),
  );
});

it.effect("runs a page's call through the handlers /mcp registered, with their access checks", () =>
  Effect.gen(function* () {
    const bridge = yield* HtmlRenderBridge.HtmlRenderBridge;
    const pinned = yield* bridge.callTool(
      {
        threadId,
        renderId,
        name: "t3_thread_organize",
        arguments: { action: "pin" },
        confirmed: true,
      },
      viewer,
    );
    expect(pinned).toMatchObject({ _tag: "Completed", isError: false });
  }).pipe(
    Effect.provide(
      HtmlRenderBridge.layer.pipe(
        Layer.provideMerge(
          McpHttpServer.layerThreadToolkit.pipe(
            Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
            Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
            Layer.provide(McpServer.McpServer.layer),
          ),
        ),
        Layer.provideMerge(McpToolDirectory.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(layerEnvironment),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(
                McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
              ),
            dispatch: () => Effect.succeed({ sequence: 1 } as never),
          }),
        ),
        Layer.provide(database),
      ),
    ),
  ),
);

it("lists only tools that /mcp serves", () => {
  const served = new Set(
    [
      OrchestratorToolkit,
      ThreadToolkit,
      ProjectToolkit,
      EnvironmentToolkit,
      WorktreeToolkit,
      JjToolkit,
      PullRequestsToolkit,
    ].flatMap((toolkit) => Object.keys(toolkit.tools)),
  );
  expect([...HtmlRenderBridge.HTML_RENDER_PAGE_TOOLS].filter((name) => !served.has(name))).toEqual(
    [],
  );
});
