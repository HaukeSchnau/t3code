import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FollowUp,
  type FollowUpActor,
  FollowUpId,
  type FollowUpSaveInput,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { ServerConfig } from "../../../config.ts";
import * as FollowUps from "../../../followUps/FollowUps.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as FollowUpHandlers from "./handlers.ts";
import { FollowUpsToolkit } from "./tools.ts";

const home = EnvironmentId.make("env:srv-2");
const peer = EnvironmentId.make("env:tower");
const threadId = ThreadId.make("thread:tower-work");
const runId = RunId.make("run:mcp-test");
const messageId = MessageId.make("message:settle");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "follow-up-tool", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "follow-up-tool", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const agentOnTower: McpInvocationContext.McpInvocationScope = {
  environmentId: peer,
  requestNamespace: "tower-session",
  thread: {
    threadId,
    providerSessionId: "tower-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const towerLinkOnHome: McpInvocationContext.McpInvocationScope = {
  environmentId: home,
  requestNamespace: "link-session",
  thread: undefined,
  client: { sessionId: "link-session", label: "tower", access: "full-access", linked: true },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const linkOf = (result: { readonly structuredContent?: unknown }) =>
  (result.structuredContent as { followUp?: { link?: string } } | undefined)?.followUp?.link;

const stored = (input: FollowUpSaveInput, actor: FollowUpActor): FollowUp => ({
  id: FollowUpId.make("fu-1"),
  title: input.title ?? "",
  body: "",
  status: "open",
  dueAt: null,
  condition: null,
  tags: [],
  links: [],
  type: null,
  fields: {},
  origin: input.origin ?? null,
  pickedUpThread: null,
  result: null,
  mergedInto: null,
  returnedAt: null,
  createdBy: actor,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  closedAt: null,
});

const serve = (
  scope: McpInvocationContext.McpInvocationScope,
  config: { readonly followUpHome?: EnvironmentId },
  record: (entry: unknown) => void,
) =>
  McpHttpServer.toolkitRegistration(FollowUpsToolkit, FollowUpHandlers.layer).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          ServerConfig,
          Effect.map(ServerConfig, (base): ServerConfig["Service"] => ({ ...base, ...config })),
        ).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-follow-up-tools-" })),
          Layer.provide(NodeServices.layer),
        ),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadRecords: () =>
            Effect.succeed({ runs: [{ id: runId, userMessageId: messageId }] } as never),
        }),
        Layer.mock(PeerForwarding.PeerForwarding)({
          call: (_scope, tool, environmentId, params) =>
            Effect.sync(() => {
              record({ tool: tool.name, environmentId, params });
              return {
                followUp: stored({ title: "forwarded" }, { kind: "agent", thread: null }),
              } as never;
            }),
        }),
        Layer.mock(FollowUps.FollowUps)({
          isGardenerThread: () => Effect.succeed(false),
          apply: ({ save: input }, actor) =>
            Effect.sync(() => {
              record({ input, actor });
              return input === undefined ? {} : { followUp: stored(input, actor) };
            }),
        }),
      ),
    ),
    Layer.provide(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
  );

const callSave = (scope: McpInvocationContext.McpInvocationScope, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "follow_up_save", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect(
  "an agent away from the home forwards its follow-up with its thread as the origin",
  () => {
    const calls: Array<unknown> = [];
    const readThread = ThreadId.make("thread:tower-read");
    return Effect.all([
      callSave(agentOnTower, { title: "Check the M2 forwarder" }),
      // A thread it names lives on its own machine, so the forward says which one.
      callSave(agentOnTower, {
        title: "From a thread it read",
        fromThread: { threadId: readThread },
      }),
    ]).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          expect(results.map((result) => result.isError)).not.toContain(true);
          // The home's answer carries no link of its own here; tower names the home.
          expect(results.map(linkOf)).toEqual([
            "[forwarded](t3-follow-up://env:srv-2/fu-1)",
            "[forwarded](t3-follow-up://env:srv-2/fu-1)",
          ]);
        }),
      ),
      Effect.andThen(
        Effect.sync(() =>
          expect(calls).toEqual([
            {
              tool: "follow_up_save",
              environmentId: home,
              params: {
                title: "Check the M2 forwarder",
                fromThread: { threadId, environmentId: peer, messageId },
              },
            },
            {
              tool: "follow_up_save",
              environmentId: home,
              params: {
                title: "From a thread it read",
                fromThread: { threadId: readThread, environmentId: peer },
              },
            },
          ]),
        ),
      ),
      Effect.provide(serve(agentOnTower, { followUpHome: home }, (entry) => calls.push(entry))),
    );
  },
);

it.effect("the home records a linked peer's thread as origin and actor", () => {
  const calls: Array<unknown> = [];
  return callSave(towerLinkOnHome, {
    title: "Check the M2 forwarder",
    fromThread: { threadId, environmentId: peer, messageId },
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.isError).not.toBe(true);
        expect(linkOf(result)).toBe("[Check the M2 forwarder](t3-follow-up://env:srv-2/fu-1)");
      }),
    ),
    Effect.andThen(
      Effect.sync(() =>
        expect(calls).toEqual([
          {
            input: {
              title: "Check the M2 forwarder",
              origin: { environmentId: peer, threadId, messageId, quote: null, threadTitle: null },
            },
            actor: { kind: "agent", thread: { environmentId: peer, threadId } },
          },
        ]),
      ),
    ),
    // The home may name itself, as every host in its space does.
    Effect.provide(serve(towerLinkOnHome, { followUpHome: home }, (entry) => calls.push(entry))),
  );
});

it.effect("an outside client, which cannot open follow-up links, gets none", () => {
  const outside: McpInvocationContext.McpInvocationScope = {
    ...towerLinkOnHome,
    client: {
      sessionId: "claude-desktop",
      label: "Claude",
      access: "full-access",
      hostedAppUrl: "https://app.t3.codes",
    },
  };
  return callSave(outside, { title: "Check the M2 forwarder" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.isError).not.toBe(true);
        expect(linkOf(result)).toBeUndefined();
      }),
    ),
    Effect.provide(serve(outside, { followUpHome: home }, () => {})),
  );
});
