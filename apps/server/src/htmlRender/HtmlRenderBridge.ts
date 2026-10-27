import {
  HtmlRenderRequestError,
  type HtmlRenderCallToolInput,
  type HtmlRenderCallToolResult,
  type HtmlRenderSetStateInput,
  type HtmlRenderState as HtmlRenderStateMap,
  type HtmlRenderStateInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { McpSchema } from "effect/ai";

import { attachmentBelongsToThread } from "../attachmentStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolDirectory from "../mcp/McpToolDirectory.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as HtmlRenderState from "./HtmlRenderState.ts";

/**
 * The T3 tools a page may call. Whether one needs the reader's confirmation comes from its
 * `Tool.Readonly` annotation, not from this list.
 */
export const HTML_RENDER_PAGE_TOOLS: ReadonlySet<string> = new Set([
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "t3_thread_configuration",
  "t3_project_list",
  "t3_project_read",
  "t3_queue_list",
  "t3_queue_read",
  "t3_worktree_list",
  "list_scheduled_tasks",
  "list_thread_pull_requests",
  "t3_environment_read",
  "t3_pending_request_list",
  "t3_thread_send",
  "t3_thread_launch",
  "t3_thread_update",
  "t3_thread_organize",
  "t3_thread_interrupt",
  "schedule_task",
  "update_scheduled_task",
  "run_scheduled_task_now",
  "t3_queue_edit",
  "t3_queue_cancel",
  "t3_queue_reorder",
  "t3_pending_request_respond",
]);

const RATE_LIMIT_CALLS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// MCP clients negotiate these at initialize; an in-process call has no client to ask.
const PAGE_REQUEST_CONTEXT = McpSchema.McpRequestContext.of({
  clientId: -1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
});

export interface HtmlRenderViewer {
  readonly sessionId: string;
}

export class HtmlRenderBridge extends Context.Service<
  HtmlRenderBridge,
  {
    readonly getState: (
      input: HtmlRenderStateInput,
    ) => Effect.Effect<HtmlRenderStateMap, HtmlRenderRequestError>;
    readonly setState: (
      input: HtmlRenderSetStateInput,
    ) => Effect.Effect<void, HtmlRenderRequestError>;
    /** Runs one allowed T3 tool for the signed-in viewer, scoped to the render's thread. */
    readonly callTool: (
      input: HtmlRenderCallToolInput,
      viewer: HtmlRenderViewer,
    ) => Effect.Effect<HtmlRenderCallToolResult, HtmlRenderRequestError>;
  }
>()("t3/htmlRender/HtmlRenderBridge") {}

const toolText = (content: ReadonlyArray<unknown>) =>
  content
    .flatMap((block) =>
      Predicate.isObject(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");

const schemaProperties = (tool: McpToolDirectory.McpToolEntry["tool"]) => {
  const properties = (tool.inputSchema as { readonly properties?: unknown }).properties;
  return Predicate.isObject(properties) ? properties : {};
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const states = yield* HtmlRenderState.HtmlRenderState;
  const directory = yield* McpToolDirectory.McpToolDirectory;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const recentCalls = new Map<string, ReadonlyArray<number>>();

  const fail = (threadId: ThreadId, reason: HtmlRenderRequestError["reason"], cause?: unknown) =>
    new HtmlRenderRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  const ownedRender = Effect.fn("HtmlRenderBridge.ownedRender")(function* (input: {
    readonly threadId: ThreadId;
    readonly renderId: string;
  }) {
    const shell = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    if (
      shell === null ||
      shell.deletedAt !== null ||
      !attachmentBelongsToThread(input.threadId, input.renderId)
    ) {
      return yield* fail(input.threadId, "render-not-found");
    }
    return shell;
  });

  const getState = Effect.fn("HtmlRenderBridge.getState")(function* (input: HtmlRenderStateInput) {
    yield* ownedRender(input);
    return yield* states
      .get(input)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  const setState = Effect.fn("HtmlRenderBridge.setState")(function* (
    input: HtmlRenderSetStateInput,
  ) {
    yield* ownedRender(input);
    yield* states
      .set(input)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  const takeCall = Effect.fn("HtmlRenderBridge.takeCall")(function* (key: string) {
    const now = yield* Clock.currentTimeMillis;
    const recent = (recentCalls.get(key) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_CALLS) {
      recentCalls.set(key, recent);
      return false;
    }
    recentCalls.set(key, [...recent, now]);
    return true;
  });

  const callTool = Effect.fn("HtmlRenderBridge.callTool")(function* (
    input: HtmlRenderCallToolInput,
    viewer: HtmlRenderViewer,
  ) {
    const shell = yield* ownedRender(input);
    const entry = HTML_RENDER_PAGE_TOOLS.has(input.name)
      ? Option.getOrUndefined(yield* directory.find(input.name))
      : undefined;
    if (entry === undefined) return yield* fail(input.threadId, "tool-not-allowed");
    if (!entry.readOnly && input.confirmed !== true) {
      return {
        _tag: "ConfirmationRequired",
        title: entry.tool.title ?? entry.tool.annotations?.title ?? input.name,
      } satisfies HtmlRenderCallToolResult;
    }
    if (!(yield* takeCall(`${input.threadId}\u0000${input.renderId}`))) {
      return yield* fail(input.threadId, "rate-limited");
    }
    // Tools that default to the calling thread would otherwise ask for one: a page has none.
    const properties = schemaProperties(entry.tool);
    const args = {
      ...("threadId" in properties ? { threadId: input.threadId } : {}),
      ...("projectId" in properties ? { projectId: shell.projectId } : {}),
      ...input.arguments,
    };
    const invocation: McpInvocationContext.McpInvocationScope = {
      environmentId,
      capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
      issuedAt: yield* Clock.currentTimeMillis,
      requestNamespace: `html-render:${viewer.sessionId}`,
      thread: undefined,
      client: {
        sessionId: viewer.sessionId,
        label: "HTML page",
        access: shell.runtimeMode,
        interactionMode: shell.interactionMode,
      },
    };
    const outcome = yield* entry
      .handle(args)
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpRequestContext, PAGE_REQUEST_CONTEXT),
        Effect.result,
      );
    if (outcome._tag === "Failure") {
      return outcome.failure._tag === "InvalidParams"
        ? ({
            _tag: "Completed",
            isError: true,
            value: outcome.failure.message,
          } satisfies HtmlRenderCallToolResult)
        : yield* fail(input.threadId, "request-failed", outcome.failure);
    }
    const result = outcome.success;
    if (Predicate.isTagged(result, "InputRequired")) {
      return yield* fail(input.threadId, "request-failed");
    }
    return {
      _tag: "Completed",
      isError: result.isError === true,
      value:
        result.structuredContent !== undefined && result.isError !== true
          ? result.structuredContent
          : toolText(result.content),
    } satisfies HtmlRenderCallToolResult;
  });

  return HtmlRenderBridge.of({ getState, setState, callTool });
});

export const layer = Layer.effect(HtmlRenderBridge, make).pipe(
  Layer.provide(HtmlRenderState.layer),
);
