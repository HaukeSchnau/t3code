import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadAskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TurnEndAskDetector from "./TurnEndAskDetector.ts";

const threadId = ThreadId.make("thread:turn-end");
const projectId = ProjectId.make("project:turn-end");
const runId = RunId.make("run:turn-end");
const instanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 12, minute));
const ending = "Should I delete them on those four hosts?";

const message = (
  id: string,
  role: "user" | "assistant",
  minute: number,
  text: string,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => ({
  createdBy: role === "user" ? "user" : "agent",
  creationSource: role === "user" ? "web" : "provider",
  id: MessageId.make(id),
  threadId,
  runId: role === "assistant" ? runId : null,
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdAt: at(minute),
  updatedAt: at(minute),
  ...overrides,
});

const projection = (
  change: (base: OrchestrationV2ThreadProjection) => OrchestrationV2ThreadProjection = (base) =>
    base,
): OrchestrationV2ThreadProjection => {
  const base = ProjectionStore.emptyProjection({
    id: EventId.make("event:created"),
    type: "thread.created",
    threadId,
    occurredAt: at(0),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Leftover skills",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at(0),
      updatedAt: at(0),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  return change({
    ...base,
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make("user-1"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(1),
        startedAt: at(1),
        completedAt: at(10),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      message("user-1", "user", 1, "Find the stale skill entries."),
      message("assistant-1", "assistant", 5, "Looking at the hosts now."),
      message("assistant-2", "assistant", 9, `I found 23 leftover dirs. ${ending}`),
    ],
  });
};

function makeHarness(
  state: OrchestrationV2ThreadProjection,
  generated: { readonly waitsOnUser: boolean; readonly ask: string } = {
    waitsOnUser: true,
    ask: "Delete 23 leftover skill dirs on 4 hosts?",
  },
) {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const generateTurnEndAsk = vi.fn<TextGeneration.TextGeneration["Service"]["generateTurnEndAsk"]>(
    () => Effect.succeed(generated),
  );
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(ProjectionStore.threadShellFromProjection(state)),
    getThreadRecords: (_threadId, _fields, filter) =>
      Effect.succeed({
        ...state,
        runs: state.runs.filter((run) => filter?.runIds?.includes(run.id) ?? true),
        messages: state.messages.filter(
          (candidate) =>
            (filter?.messageRoles?.includes(candidate.role) ?? true) &&
            (filter?.messageRunIds === undefined ||
              (candidate.runId !== null && filter.messageRunIds.includes(candidate.runId))),
        ),
        turnItems: state.turnItems.filter(
          (item) => filter?.turnItemTypes?.includes(item.type) ?? true,
        ),
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length, storedEvents: [] };
      }),
  });
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getLatestUserReply: () =>
      Effect.succeed(state.messages.findLast((candidate) => candidate.role === "user")),
  });
  const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: () =>
      Effect.succeedSome({
        projectId,
        title: "Project",
        workspaceRoot: "/repo",
        defaultModelSelection: { instanceId, model: "gpt-5.4" },
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: "2026-11-19T00:00:00.000Z",
        updatedAt: "2026-11-19T00:00:00.000Z",
        pinnedAt: null,
        archivedAt: null,
        deletedAt: null,
      }),
  });
  return {
    layer: Layer.mergeAll(
      threads,
      projections,
      projects,
      ServerSettings.layerTest(),
      Layer.mock(TextGeneration.TextGeneration)({ generateTurnEndAsk }),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
    dispatched,
    generateTurnEndAsk,
  };
}

const detectOnce = Effect.gen(function* () {
  const detector = yield* TurnEndAskDetector.make;
  yield* detector.detect(threadId, runId);
  // A later update of the completed run repeats its status; it is classified once.
  yield* detector.detect(threadId, runId);
  yield* detector.drain;
});

describe("TurnEndAskDetector", () => {
  it.effect("raises a guarded turn-end ask from the run's final message", () =>
    Effect.gen(function* () {
      const harness = makeHarness(projection());
      yield* detectOnce.pipe(Effect.provide(harness.layer));

      assert.equal(harness.generateTurnEndAsk.mock.calls.length, 1);
      const input = harness.generateTurnEndAsk.mock.calls[0]?.[0];
      assert.include(input?.finalMessage, ending);
      assert.equal(input?.userMessage, "Find the stale skill entries.");
      assert.deepEqual(harness.dispatched, [
        {
          type: "thread.ask.raise",
          commandId: `thread-ask:turn-end:${runId}`,
          threadId,
          askId: ThreadAskId.make(`turn_end:${runId}`),
          source: { type: "turn_end", runId },
          text: "Delete 23 leftover skill dirs on 4 hosts?",
        } as OrchestrationV2ServerCommand,
      ]);
    }),
  );

  it.effect("raises nothing when the ending does not wait on the user", () =>
    Effect.gen(function* () {
      const harness = makeHarness(projection(), { waitsOnUser: false, ask: "" });
      yield* detectOnce.pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateTurnEndAsk.mock.calls.length, 1);
      assert.lengthOf(harness.dispatched, 0);
    }),
  );

  const stopRequest: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item:stop"),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 150,
    status: "completed",
    title: null,
    startedAt: at(8),
    completedAt: at(8),
    updatedAt: at(8),
    type: "run_interrupt_request",
    message: "Stop",
  };

  it.effect.each([
    [
      "a subagent thread",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        thread: {
          ...base.thread,
          lineage: {
            parentThreadId: ThreadId.make("thread:parent"),
            relationshipToParent: "subagent" as const,
            rootThreadId: ThreadId.make("thread:parent"),
          },
        },
      }),
    ],
    [
      "an archived thread",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        thread: { ...base.thread, archivedAt: at(11) },
      }),
    ],
    [
      "a pending question",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("request:question"),
            nodeId: NodeId.make("node:root"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input" as const,
            status: "pending" as const,
            responseCapability: { type: "message" as const },
            createdAt: at(9),
            resolvedAt: null,
          },
        ],
      }),
    ],
    [
      "a stopped run",
      (base: OrchestrationV2ThreadProjection) => ({ ...base, turnItems: [stopRequest] }),
    ],
    [
      "a run without a final message",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        messages: base.messages.filter((candidate) => candidate.role === "user"),
      }),
    ],
    [
      "a user reply after the run",
      (base: OrchestrationV2ThreadProjection) => ({
        ...base,
        messages: [...base.messages, message("user-2", "user", 12, "Yes, delete them.")],
      }),
    ],
  ] as const)("skips %s", ([, change]) =>
    Effect.gen(function* () {
      const harness = makeHarness(projection(change));
      yield* detectOnce.pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateTurnEndAsk.mock.calls.length, 0);
      assert.lengthOf(harness.dispatched, 0);
    }),
  );
});
