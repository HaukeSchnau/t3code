import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, TurnId, type ProviderSession } from "@t3tools/contracts";

import type { ProjectionRestartSafetyThread } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { summarizeServerIdleStatus } from "./IdleStatus.ts";

const runtimeStartedAt = "2026-07-16T08:29:00.000Z";
const now = "2026-07-16T12:00:00.000Z";

function projected(
  overrides: Partial<ProjectionRestartSafetyThread> = {},
): ProjectionRestartSafetyThread {
  return {
    threadId: "thread-1",
    session: null,
    latestTurnId: null,
    latestTurnState: null,
    latestTurnUpdatedAt: null,
    queuedMessageCount: 0,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    undeliveredTranscriptEventCount: 0,
    ...overrides,
  } as ProjectionRestartSafetyThread;
}

function summarize(input: {
  liveSessions?: ReadonlyArray<ProviderSession>;
  threads?: ReadonlyArray<ProjectionRestartSafetyThread>;
  liveStateKnown?: boolean;
}) {
  return summarizeServerIdleStatus({
    liveSessions: input.liveSessions ?? [],
    projectedState: { threads: input.threads ?? [] },
    checkedAt: now,
    runtimeStartedAt,
    liveStateKnown: input.liveStateKnown ?? true,
  });
}

it("reports idle when live and projected state have no pending work", () => {
  const status = summarize({});
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
  const status = summarize({ liveSessions: [liveSession] });
  assert.isFalse(status.idle);
  assert.equal(status.liveActiveTurnCount, 1);
  assert.equal(status.busyThreads[0]?.reason, "live-provider-active-turn");
});

for (const status of ["running", "connecting"] as const) {
  it(`treats live ${status} provider sessions without a turn id as busy`, () => {
    const liveSession = {
      provider: "codex",
      providerInstanceId: "codex",
      status,
      runtimeMode: "full-access",
      threadId: `thread-live-${status}`,
      createdAt: now,
      updatedAt: now,
    } as ProviderSession;

    const result = summarize({ liveSessions: [liveSession] });
    assert.isFalse(result.idle);
    assert.equal(result.liveActiveTurnCount, 1);
    assert.equal(result.busyThreads[0]?.reason, "live-provider-session-busy");
    assert.equal(result.busyThreads[0]?.turnId, null);
  });
}

it("does not let old orphaned projections block a live restart probe", () => {
  const status = summarize({
    threads: [
      projected({
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-old"),
          lastError: null,
          updatedAt: "2026-07-15T12:00:00.000Z",
        },
        latestTurnId: TurnId.make("turn-old"),
        latestTurnState: "running",
      }),
    ],
  });
  assert.isTrue(status.idle);
  assert.equal(status.projectedActiveTurnCount, 1);
  assert.equal(status.projectedRunningTurnCount, 1);
});

it("fails closed for current-epoch projected work and offline probes", () => {
  const thread = projected({
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "starting",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-07-16T08:30:00.000Z",
    },
  });
  assert.isFalse(summarize({ threads: [thread] }).idle);
  assert.isFalse(summarize({ threads: [thread], liveStateKnown: false }).idle);
});

it("counts durable actionable state without treating it as unsafe to restart", () => {
  const status = summarize({
    threads: [
      projected({
        queuedMessageCount: 2,
        pendingApprovalCount: 1,
        pendingUserInputCount: 3,
      }),
    ],
  });
  assert.isTrue(status.idle);
  assert.equal(status.queuedMessageCount, 2);
  assert.equal(status.pendingApprovalCount, 1);
  assert.equal(status.pendingUserInputCount, 3);
});

it("blocks restart while durable transcript events await ingestion", () => {
  const status = summarize({
    threads: [projected({ undeliveredTranscriptEventCount: 4 })],
  });
  assert.isFalse(status.idle);
  assert.equal(status.busyThreads[0]?.reason, "undelivered-transcript-events");
});
