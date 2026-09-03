import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { deriveMonitorTimelineEntries, resolveMonitorThreadCandidate } from "./MonitorView";
import type { SidebarThreadSummary } from "../types";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const turnId = TurnId.make("turn-1");
const completedAt = "2026-06-16T19:42:44.451Z";

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
    threadId: ThreadId.make("thread-1"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    status: "ready",
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
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
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    createdAt: "2026-06-16T19:30:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
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

describe("deriveMonitorTimelineEntries", () => {
  it("renders only hot activity and never exposes compact historical placeholders", () => {
    const entries = deriveMonitorTimelineEntries({
      messages: [],
      proposedPlans: [],
      activities: [
        {
          id: EventId.make("hot-activity"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Current tool",
          payload: { detail: "current" },
          turnId,
          sequence: 1,
          createdAt: completedAt,
        },
      ],
      historicalActivityGroups: [
        {
          turnId: TurnId.make("historical-turn"),
          revision: 3,
          activityCount: 20,
          payloadBytes: 100_000,
          displayActivityCount: 10,
          firstActivityAt: "2026-06-16T18:00:00.000Z",
          lastActivityAt: "2026-06-16T18:10:00.000Z",
        },
      ],
    } as Parameters<typeof deriveMonitorTimelineEntries>[0]);

    expect(entries.map((entry) => entry.id)).toEqual(["hot-activity"]);
  });
});

describe("resolveMonitorThreadCandidate", () => {
  it("treats an idle default-mode thread as ready", () => {
    const candidate = resolveMonitorThreadCandidate(
      makeThread({ hasActionableProposedPlan: true, session: makeSession() }),
    );

    expect(candidate.reason).toBe("ready");
  });

  it("classifies plan-mode threads with an unimplemented plan as plan ready", () => {
    const candidate = resolveMonitorThreadCandidate(
      makeThread({
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        session: makeSession(),
      }),
    );

    expect(candidate.reason).toBe("plan");
  });

  it("does not keep a thread blocked when a completed turn is newer than the session error", () => {
    const candidate = resolveMonitorThreadCandidate(
      makeThread({
        session: makeSession({
          status: "error",
          activeTurnId: turnId,
          lastError: "Codex stream disconnected after exhausting reconnect attempts.",
          updatedAt: "2026-06-16T19:34:27.275Z",
        }),
      }),
    );

    expect(candidate.reason).toBe("ready");
  });

  it("keeps current session errors blocked", () => {
    const candidate = resolveMonitorThreadCandidate(
      makeThread({
        session: makeSession({
          status: "error",
          activeTurnId: turnId,
          lastError: "Codex stream disconnected after exhausting reconnect attempts.",
          updatedAt: "2026-06-16T19:45:00.000Z",
        }),
      }),
    );

    expect(candidate.reason).toBe("error");
  });
});
