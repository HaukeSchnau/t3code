import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as LocalAgentAwareness from "./LocalAgentAwareness.ts";
import * as LocalAgentAwarenessPublisher from "./LocalAgentAwarenessPublisher.ts";

const THREAD_ID = ThreadId.make("thread");
const PROJECT_ID = ProjectId.make("project");
const NOW = "2026-09-04T12:00:00.000Z";

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const makePublisher = Effect.gen(function* () {
  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell());
  const published: Array<RelayAgentActivityState | null> = [];
  const publisher = yield* LocalAgentAwarenessPublisher.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(LocalAgentAwareness.LocalAgentAwareness)({
          publish: ({ state }) => Effect.sync(() => void published.push(state)),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Ref.get(currentShell),
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: PROJECT_ID,
                title: "Project",
                workspaceRoot: "/workspace",
                defaultModelSelection: null,
                scripts: [],
                createdAt: NOW,
                updatedAt: NOW,
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
        }),
      ),
    ),
  );
  return { publisher, currentShell, published };
});

it.effect("publishes live activity at once and confirms a tombstone after five seconds", () =>
  Effect.gen(function* () {
    const { publisher, currentShell, published } = yield* makePublisher;
    yield* publisher.publishThread(THREAD_ID);
    assert.deepEqual(
      published.map((state) => state?.phase),
      ["running"],
    );

    yield* Ref.set(currentShell, null);
    yield* publisher.publishThread(THREAD_ID);
    yield* TestClock.adjust("4 seconds");
    yield* publisher.drain;
    assert.equal(published.length, 1);

    yield* TestClock.adjust("1 second");
    yield* publisher.drain;
    assert.deepEqual(published.at(-1), null);
  }),
);

it.effect("drops a transient first completion that recovers within five seconds", () =>
  Effect.gen(function* () {
    const { publisher, currentShell, published } = yield* makePublisher;
    yield* Ref.set(
      currentShell,
      shell({
        status: "completed",
        latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
      }),
    );
    yield* publisher.publishThread(THREAD_ID);
    assert.equal(published.length, 0);

    yield* Ref.set(currentShell, shell());
    yield* publisher.publishThread(THREAD_ID);
    yield* TestClock.adjust("5 seconds");
    yield* publisher.drain;
    assert.deepEqual(
      published.map((state) => state?.phase),
      ["running"],
    );
  }),
);

it.effect("keeps completions from before startup quiet", () =>
  Effect.gen(function* () {
    const { publisher, currentShell, published } = yield* makePublisher;
    yield* Ref.set(
      currentShell,
      shell({
        status: "completed",
        latestRunCompletedAt: DateTime.subtract(yield* DateTime.now, { seconds: 1 }),
      }),
    );
    yield* publisher.publishThread(THREAD_ID);
    yield* TestClock.adjust("5 seconds");
    yield* publisher.drain;
    assert.equal(published.length, 0);
  }),
);
