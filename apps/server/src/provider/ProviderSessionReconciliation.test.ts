import { describe, expect, it } from "vite-plus/test";
import { TurnId, type ProviderSession } from "@t3tools/contracts";

import type { ProjectionRestartSafetyThread } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { decideProviderSessionReconciliation } from "./ProviderSessionReconciliation.ts";

const runtimeStartedAt = "2026-07-16T08:29:00.000Z";

function projected(updatedAt: string): ProjectionRestartSafetyThread {
  return {
    threadId: "thread-1",
    session: {
      threadId: "thread-1",
      status: "running",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: "turn-1",
      lastError: null,
      updatedAt,
    },
    latestTurnId: "turn-1",
    latestTurnState: "running",
    latestTurnUpdatedAt: updatedAt,
    queuedMessageCount: 0,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    undeliveredTranscriptEventCount: 0,
  } as ProjectionRestartSafetyThread;
}

function live(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    provider: "codex",
    providerInstanceId: "codex",
    threadId: "thread-1",
    status: "ready",
    runtimeMode: "full-access",
    createdAt: runtimeStartedAt,
    updatedAt: runtimeStartedAt,
    ...overrides,
  } as ProviderSession;
}

describe("decideProviderSessionReconciliation", () => {
  it("interrupts an orphaned active projection inherited from an older process", () => {
    expect(
      decideProviderSessionReconciliation({
        projected: projected("2026-07-15T14:28:38.073Z"),
        liveSession: undefined,
        runtimeStartedAt,
      }),
    ).toMatchObject({
      _tag: "Repair",
      reason: "stale_projected_turn",
      repair: { _tag: "SetSession", status: "interrupted" },
    });
  });

  it("preserves a matching live active turn regardless of projection age", () => {
    expect(
      decideProviderSessionReconciliation({
        projected: projected("2026-07-15T14:28:38.073Z"),
        liveSession: live({ activeTurnId: TurnId.make("turn-1"), status: "running" }),
        runtimeStartedAt,
      }),
    ).toEqual({ _tag: "Skip", reason: "live_turn_active" });
  });

  it("treats a running live session without an active turn id as positive live evidence", () => {
    expect(
      decideProviderSessionReconciliation({
        projected: projected("2026-07-15T14:28:38.073Z"),
        liveSession: live({ status: "running", activeTurnId: undefined }),
        runtimeStartedAt,
      }),
    ).toEqual({ _tag: "Skip", reason: "live_turn_active" });
  });

  it("fails closed for current-process projections", () => {
    expect(
      decideProviderSessionReconciliation({
        projected: projected("2026-07-16T08:30:00.000Z"),
        liveSession: undefined,
        runtimeStartedAt,
      }),
    ).toEqual({ _tag: "Skip", reason: "projection_current" });
  });

  it("waits for durable transcript ingestion before repairing", () => {
    expect(
      decideProviderSessionReconciliation({
        projected: { ...projected("2026-07-15T14:28:38.073Z"), undeliveredTranscriptEventCount: 1 },
        liveSession: undefined,
        runtimeStartedAt,
      }),
    ).toEqual({ _tag: "Skip", reason: "transcript_backlog" });
  });

  it("settles an old projection to the terminal live session state", () => {
    expect(
      decideProviderSessionReconciliation({
        projected: projected("2026-07-15T14:28:38.073Z"),
        liveSession: live(),
        runtimeStartedAt,
      }),
    ).toMatchObject({
      _tag: "Repair",
      reason: "terminal_live_session",
      repair: { _tag: "SetSession", status: "ready" },
    });
  });

  it("interrupts a legacy running turn without inventing a missing session", () => {
    expect(
      decideProviderSessionReconciliation({
        projected: {
          ...projected("2026-07-15T14:28:38.073Z"),
          session: null,
          latestTurnId: TurnId.make("legacy-turn"),
          latestTurnState: "running",
          latestTurnUpdatedAt: "2026-07-15T14:28:38.073Z",
        },
        liveSession: undefined,
        runtimeStartedAt,
      }),
    ).toEqual({
      _tag: "Repair",
      reason: "stale_projected_turn",
      repair: { _tag: "InterruptTurn", turnId: TurnId.make("legacy-turn") },
    });
  });

  it("fails closed for a sessionless running turn created by the current process", () => {
    expect(
      decideProviderSessionReconciliation({
        projected: {
          ...projected("2026-07-16T08:30:00.000Z"),
          session: null,
        },
        liveSession: undefined,
        runtimeStartedAt,
      }),
    ).toEqual({ _tag: "Skip", reason: "projection_current" });
  });
});
