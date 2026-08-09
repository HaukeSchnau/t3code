import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");

function makeReadModel(turnState: "interrupted" | "completed" = "interrupted") {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: TURN_ID,
          state: turnState,
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "interrupted",
          providerName: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: TURN_ID,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
    usageLimits: [],
    updatedAt: NOW,
  } satisfies OrchestrationReadModel;
}

it.layer(NodeServices.layer)("turn resume decider", (it) => {
  it.effect("requests a message-free continuation of the latest interrupted turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.resume",
          commandId: CommandId.make("cmd-resume"),
          threadId: THREAD_ID,
          interruptedTurnId: TURN_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.turn-start-requested",
        payload: {
          threadId: THREAD_ID,
          messageId: null,
          resumedFromTurnId: TURN_ID,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      });
    }),
  );

  it.effect("rejects a turn that is no longer the latest interrupted turn", () =>
    Effect.gen(function* () {
      const failure = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.resume",
          commandId: CommandId.make("cmd-stale-resume"),
          threadId: THREAD_ID,
          interruptedTurnId: TURN_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel("completed"),
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
