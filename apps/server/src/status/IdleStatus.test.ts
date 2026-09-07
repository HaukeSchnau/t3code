import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as EffectDateTime from "effect/DateTime";

import { summarizeServerIdleStatus } from "./IdleStatus.ts";

const now = "2026-07-16T12:00:00.000Z";
const checkedAt = now;

function shell(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    activeRunId: null,
    activityRunStatus: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: EffectDateTime.makeUnsafe(now),
    updatedAt: EffectDateTime.makeUnsafe(now),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  } as OrchestrationV2ThreadShell;
}

it("reports idle when the V2 shell has no active run", () => {
  const status = summarizeServerIdleStatus({ threads: [], checkedAt });
  assert.isTrue(status.idle);
  assert.equal(status.busyThreadCount, 0);
});

it("treats active V2 runs as busy", () => {
  const status = summarizeServerIdleStatus({
    threads: [
      shell({
        activeRunId: RunId.make("run-1"),
        activityRunStatus: "running",
        status: "running",
      }),
    ],
    checkedAt,
  });
  assert.isFalse(status.idle);
  assert.equal(status.liveActiveTurnCount, 1);
  assert.equal(status.projectedActiveTurnCount, 1);
  assert.equal(status.projectedRunningTurnCount, 1);
  assert.equal(status.busyThreads[0]?.reason, "projected-active-turn");
});

it("fails closed while a V2 run is starting", () => {
  const status = summarizeServerIdleStatus({
    threads: [shell({ activityRunStatus: "starting", status: "starting" })],
    checkedAt,
  });
  assert.isFalse(status.idle);
  assert.equal(status.projectedStartingSessionCount, 1);
  assert.equal(status.busyThreads[0]?.reason, "projected-session-starting");
});

it("keeps queued and pending requests visible without blocking restart", () => {
  const status = summarizeServerIdleStatus({
    threads: [
      shell({
        status: "queued",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind: "command",
          createdAt: EffectDateTime.makeUnsafe(now),
        },
      }),
      shell({
        id: ThreadId.make("thread-2"),
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-2"),
          kind: "user_input",
          createdAt: EffectDateTime.makeUnsafe(now),
        },
      }),
    ],
    checkedAt,
  });
  assert.isTrue(status.idle);
  assert.equal(status.queuedMessageCount, 1);
  assert.equal(status.pendingApprovalCount, 1);
  assert.equal(status.pendingUserInputCount, 1);
});

it("keeps V2 waiting runs restart-blocking", () => {
  const status = summarizeServerIdleStatus({
    threads: [shell({ activityRunStatus: "waiting", status: "waiting" })],
    checkedAt,
  });
  assert.isFalse(status.idle);
  assert.equal(status.busyThreads[0]?.reason, "projected-latest-turn-running");
});
