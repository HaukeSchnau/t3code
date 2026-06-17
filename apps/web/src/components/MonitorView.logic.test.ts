import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { resolveMonitorThreadCandidate } from "./MonitorView";
import type { SidebarThreadSummary } from "../types";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const turnId = TurnId.make("turn-1");
const completedAt = "2026-06-16T19:42:44.451Z";
const recentNow = Date.parse("2026-06-16T19:50:00.000Z");

function makeLatestTurn(
  overrides: Partial<NonNullable<SidebarThreadSummary["latestTurn"]>> = {},
): NonNullable<SidebarThreadSummary["latestTurn"]> {
  return {
    turnId,
    state: "completed",
    requestedAt: "2026-06-16T19:31:17.871Z",
    startedAt: "2026-06-16T19:31:17.871Z",
    completedAt,
    assistantMessageId: null,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<NonNullable<SidebarThreadSummary["session"]>> = {},
): NonNullable<SidebarThreadSummary["session"]> {
  return {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: "2026-06-16T19:31:17.871Z",
    updatedAt: "2026-06-16T19:42:44.451Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-1"),
    environmentId,
    projectId,
    title: "Thread",
    interactionMode: "default",
    session: null,
    createdAt: "2026-06-16T19:30:00.000Z",
    archivedAt: null,
    updatedAt: completedAt,
    latestTurn: makeLatestTurn(),
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("resolveMonitorThreadCandidate", () => {
  it("treats a completed default-mode thread with an old unimplemented plan as complete", () => {
    const candidate = resolveMonitorThreadCandidate(
      makeThread({
        hasActionableProposedPlan: true,
        session: makeSession(),
      }),
      recentNow,
    );

    expect(candidate?.reason).toBe("recent");
  });

  it("classifies settled plan-mode threads with an unimplemented plan as plan ready", () => {
    const candidate = resolveMonitorThreadCandidate(
      makeThread({
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        session: makeSession(),
      }),
      recentNow,
    );

    expect(candidate?.reason).toBe("plan");
  });

  it("does not keep a thread blocked when a completed turn is newer than the session error", () => {
    const candidate = resolveMonitorThreadCandidate(
      makeThread({
        session: makeSession({
          status: "error",
          orchestrationStatus: "error",
          activeTurnId: turnId,
          lastError: "Codex stream disconnected after exhausting reconnect attempts.",
          updatedAt: "2026-06-16T19:34:27.275Z",
        }),
      }),
      recentNow,
    );

    expect(candidate?.reason).toBe("recent");
  });

  it("keeps current session errors blocked", () => {
    const candidate = resolveMonitorThreadCandidate(
      makeThread({
        session: makeSession({
          status: "error",
          orchestrationStatus: "error",
          activeTurnId: turnId,
          lastError: "Codex stream disconnected after exhausting reconnect attempts.",
          updatedAt: "2026-06-16T19:45:00.000Z",
        }),
      }),
      recentNow,
    );

    expect(candidate?.reason).toBe("error");
  });
});
