import {
  type EnvironmentId,
  type FollowUpActor,
  type FollowUpError,
  type FollowUpOrigin,
  type FollowUpSaveInput,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Tool } from "effect/ai";

import { ServerConfig } from "../../../config.ts";
import * as FollowUps from "../../../followUps/FollowUps.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type FollowUpFromThread,
  type FollowUpSaveResult,
  FollowUpSaveTool,
  FollowUpsTool,
  FollowUpsToolkit,
  type LinkedFollowUp,
} from "./tools.ts";

const toFailure = (error: FollowUpError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** The home that keeps this environment's follow-ups, when it is another environment. */
const remoteHome = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return config.followUpHome === undefined || config.followUpHome === scope.environmentId
    ? undefined
    : config.followUpHome;
});

const forward = Effect.fn("FollowUpTools.forward")(function* <T extends Tool.Any>(
  tool: T,
  home: EnvironmentId,
  params: Tool.Parameters<T>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  return yield* forwarding.call(scope, tool, home, params);
});

/**
 * Links name `home`, the store that keeps the follow-up. A forwarded result's links are rebuilt
 * here, since only this side knows whether its caller can open them.
 */
const linkedTo =
  (scope: McpInvocationContext.McpInvocationScope, home: EnvironmentId) =>
  ({ link: _forwarded, ...followUp }: typeof LinkedFollowUp.Type): typeof LinkedFollowUp.Type => {
    const link = McpInvocationContext.followUpLinkFor(
      scope,
      { environmentId: home, followUpId: followUp.id },
      followUp.title,
    );
    return link === undefined ? followUp : { ...followUp, link };
  };

const linkSaved =
  (scope: McpInvocationContext.McpInvocationScope, home: EnvironmentId) =>
  (result: typeof FollowUpSaveResult.Type): typeof FollowUpSaveResult.Type =>
    result.followUp === undefined
      ? result
      : { ...result, followUp: linkedTo(scope, home)(result.followUp) };

/** The calling thread here, at the user message that started its current turn. */
const callingThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) return undefined;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadId = scope.thread.threadId;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  const runId = shell?.activeRunId ?? shell?.latestRunId ?? null;
  const records =
    runId === null
      ? null
      : yield* threads
          .getThreadRecords(threadId, ["runs"], { runIds: [runId] })
          .pipe(Effect.orElseSucceed(() => null));
  const run = records?.runs.find((candidate) => candidate.id === runId);
  return {
    threadId,
    environmentId: scope.environmentId,
    messageId: run?.userMessageId ?? undefined,
    title: shell?.title ?? null,
  };
});

const originOf = (
  from: typeof FollowUpFromThread.Type,
  here: EnvironmentId,
  threadTitle: string | null,
): FollowUpOrigin => ({
  environmentId: from.environmentId ?? here,
  threadId: from.threadId,
  messageId: from.messageId ?? null,
  quote: from.quote ?? null,
  threadTitle,
});

/** A thread here that `fromThread` names must exist; another environment's is taken as given. */
const titleOf = Effect.fn("FollowUpTools.titleOf")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: `There is no thread ${threadId} in this environment to name in fromThread.`,
    });
  }
  return shell.title;
});

type SaveParams = Tool.Parameters<typeof FollowUpSaveTool>;

const hasFollowUpChange = (params: SaveParams) =>
  Object.entries(params).some(
    ([key, value]) => value !== undefined && key !== "defineType" && key !== "fromThread",
  );

const save = Effect.fn("FollowUpTools.save")(function* (params: SaveParams) {
  const home = yield* remoteHome;
  const caller = yield* callingThread;
  if (home !== undefined) {
    // The home sees only this environment's link, so the caller travels as `fromThread`: the
    // thread it names, completed here where that thread lives, or the caller itself. An update
    // ignores origin, so it carries the caller, who acts and may pick the follow-up up.
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const named = params.id === undefined ? params.fromThread : undefined;
    if (
      named !== undefined &&
      (named.environmentId ?? scope.environmentId) === scope.environmentId
    ) {
      yield* titleOf(named.threadId);
    }
    const fromThread =
      named !== undefined
        ? { ...named, environmentId: named.environmentId ?? scope.environmentId }
        : caller === undefined
          ? params.fromThread === undefined
            ? undefined
            : {
                ...params.fromThread,
                environmentId: params.fromThread.environmentId ?? scope.environmentId,
              }
          : {
              threadId: caller.threadId,
              environmentId: caller.environmentId,
              ...(caller.messageId === undefined ? {} : { messageId: caller.messageId }),
            };
    return yield* forward(FollowUpSaveTool, home, {
      ...params,
      ...(fromThread === undefined ? {} : { fromThread }),
    }).pipe(Effect.map(linkSaved(scope, home)));
  }

  const scope = yield* McpInvocationContext.McpInvocationContext;
  const followUps = yield* FollowUps.FollowUps;
  const from = params.fromThread;
  const fromHere =
    from !== undefined && (from.environmentId ?? scope.environmentId) === scope.environmentId;
  const origin: FollowUpOrigin | undefined =
    from !== undefined
      ? originOf(from, scope.environmentId, fromHere ? yield* titleOf(from.threadId) : null)
      : caller === undefined
        ? undefined
        : originOf(caller, scope.environmentId, caller.title);
  // A forwarded call carries its caller as `fromThread`; a local one is this thread.
  const actingThread =
    caller !== undefined
      ? { environmentId: caller.environmentId, threadId: caller.threadId }
      : origin === undefined
        ? null
        : { environmentId: origin.environmentId, threadId: origin.threadId };
  const actor: FollowUpActor = {
    kind:
      actingThread !== null && (yield* followUps.isGardenerThread(actingThread))
        ? "gardener"
        : "agent",
    thread: actingThread,
  };

  if (!hasFollowUpChange(params)) {
    if (params.defineType === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Give a follow-up to write or change, or a type to define.",
      });
    }
    return yield* followUps
      .apply({ defineType: params.defineType }, actor)
      .pipe(Effect.mapError(toFailure));
  }

  if (params.status === "picked_up" && actingThread === null) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Only an agent in a thread can pick up a follow-up.",
    });
  }
  const input: FollowUpSaveInput = {
    ...(params.id === undefined ? {} : { id: params.id }),
    ...(params.title === undefined ? {} : { title: params.title }),
    ...(params.body === undefined ? {} : { body: params.body }),
    ...(params.mergeInto === undefined
      ? params.status === undefined
        ? {}
        : { status: params.status }
      : { status: "merged" as const, mergedInto: params.mergeInto }),
    ...(params.dueAt === undefined ? {} : { dueAt: params.dueAt }),
    ...(params.condition === undefined ? {} : { condition: params.condition }),
    ...(params.tags === undefined ? {} : { tags: params.tags }),
    ...(params.links === undefined ? {} : { links: params.links }),
    ...(params.type === undefined ? {} : { type: params.type }),
    ...(params.fields === undefined ? {} : { fields: params.fields }),
    ...(params.result === undefined ? {} : { result: params.result }),
    ...(params.status === "picked_up" && actingThread !== null
      ? { pickedUpThread: actingThread }
      : {}),
    ...(params.id === undefined && origin !== undefined ? { origin } : {}),
  };
  return yield* followUps
    .apply(
      {
        save: input,
        ...(params.defineType === undefined ? {} : { defineType: params.defineType }),
      },
      actor,
    )
    .pipe(Effect.map(linkSaved(scope, scope.environmentId)), Effect.mapError(toFailure));
});

const search = Effect.fn("FollowUpTools.search")(function* (
  params: Tool.Parameters<typeof FollowUpsTool>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const home = yield* remoteHome;
  if (home !== undefined) {
    const result = yield* forward(FollowUpsTool, home, params);
    return { ...result, followUps: result.followUps.map(linkedTo(scope, home)) };
  }
  const followUps = yield* FollowUps.FollowUps;
  const matches = yield* followUps
    .search({
      query: params.query,
      ids: params.ids,
      statuses: params.status,
      tags: params.tags,
      type: params.type,
      limit: params.limit,
    })
    .pipe(Effect.mapError(toFailure));
  const types = yield* followUps.types.pipe(Effect.mapError(toFailure));
  return {
    followUps: matches.map((match) => linkedTo(scope, scope.environmentId)(match.followUp)),
    types,
  };
});

const handlers = {
  follow_ups: McpToolAccess.reads(search),
  // Peers in the same space save here through their link, so linked callers are expected.
  follow_up_save: McpToolAccess.writes(save, { linkedCallers: "allowed" }),
} satisfies McpToolAccess.Handlers<typeof FollowUpsToolkit.tools>;

export const layer = McpToolAccess.toLayer(FollowUpsToolkit, handlers);
