import { assert, it } from "@effect/vitest";
import type {
  OrchestrationReadModel,
  OrchestrationThread,
  ProviderSession,
} from "@t3tools/contracts";

import { summarizeServerIdleStatus } from "./IdleStatus.ts";

const now = "2026-07-07T12:00:00.000Z";

const makeThread = (overrides: Record<string, unknown>): OrchestrationThread =>
  ({
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    workspaceId: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    queuedMessages: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  }) as unknown as OrchestrationThread;

const makeSnapshot = (threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    projects: [],
    threads,
    usageLimits: [],
  }) as unknown as OrchestrationReadModel;

it("reports idle when live and projected state have no pending work", () => {
  const status = summarizeServerIdleStatus({
    liveSessions: [],
    snapshot: makeSnapshot([makeThread({})]),
    checkedAt: now,
  });

  assert.isTrue(status.idle);
  assert.equal(status.busyThreadCount, 0);
});

it("treats live provider active turns as busy", () => {
  const liveSession = {
    provider: "codex",
    providerInstanceId: "codex",
    status: "running",
    runtimeMode: "full-access",
    threadId: "thread-live",
    activeTurnId: "turn-live",
    createdAt: now,
    updatedAt: now,
  } as ProviderSession;

  const status = summarizeServerIdleStatus({
    liveSessions: [liveSession],
    snapshot: makeSnapshot([]),
    checkedAt: now,
  });

  assert.isFalse(status.idle);
  assert.equal(status.liveActiveTurnCount, 1);
  assert.equal(status.busyThreads[0]?.reason, "live-provider-active-turn");
});

it("treats projected turn gaps, queues, approvals, and user input as busy", () => {
  const status = summarizeServerIdleStatus({
    liveSessions: [],
    snapshot: makeSnapshot([
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "running",
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
        queuedMessages: [
          {
            messageId: "message-queued",
            threadId: "thread-1",
            text: "next",
            attachments: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        activities: [
          {
            id: "approval-1",
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: "approval-request-1" },
            turnId: "turn-1",
            createdAt: now,
          },
          {
            id: "user-input-1",
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: { requestId: "user-input-request-1" },
            turnId: "turn-1",
            createdAt: now,
          },
        ],
      }),
    ]),
    checkedAt: now,
  });

  assert.isFalse(status.idle);
  assert.equal(status.projectedRunningTurnCount, 1);
  assert.equal(status.queuedMessageCount, 1);
  assert.equal(status.pendingApprovalCount, 1);
  assert.equal(status.pendingUserInputCount, 1);
});
