import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThread, EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { deriveMonitorTimelineEntries, resolveMonitorThreadCandidate } from "./MonitorView";

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class MockDiffsWorker {},
}));

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const completedAt = "2026-06-16T19:42:44.451Z";
const providerInstanceId = ProviderInstanceId.make("codex");

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRun: { runId: "run-1" as never, status: "completed", requestedAt: completedAt, startedAt: completedAt, completedAt, assistantMessageId: null },
    runtime: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: "2026-06-16T19:30:00.000Z",
    updatedAt: completedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    deletedAt: null,
    source: {} as EnvironmentThreadShell["source"],
    ...overrides,
  };
}

describe("deriveMonitorTimelineEntries", () => {
  it("uses the V2 visible item order", () => {
    const projection = {
      projection: {
        visibleTurnItems: [],
        attempts: [],
        nodes: [],
        plans: [],
      },
    } as unknown as EnvironmentThread;
    expect(deriveMonitorTimelineEntries(projection)).toEqual([]);
  });
});

describe("resolveMonitorThreadCandidate", () => {
  it("treats an idle default-mode thread as ready", () => {
    expect(resolveMonitorThreadCandidate(makeThread({ hasActionableProposedPlan: true })).reason).toBe("ready");
  });

  it("classifies settled plan-mode threads with an unimplemented plan", () => {
    expect(resolveMonitorThreadCandidate(makeThread({ interactionMode: "plan", hasActionableProposedPlan: true })).reason).toBe("plan");
  });

  it("marks active runtime errors as blocked", () => {
    expect(resolveMonitorThreadCandidate(makeThread({ runtime: { status: "failed", activeRunId: null, providerInstanceId, providerName: null, lastError: "failed", updatedAt: completedAt } })).reason).toBe("error");
  });

  it("prioritizes pending requests over a running status", () => {
    expect(resolveMonitorThreadCandidate(makeThread({ runtime: { status: "running", activeRunId: "run-1" as never, providerInstanceId, providerName: null, lastError: null, updatedAt: completedAt }, hasPendingApprovals: true })).reason).toBe("actionable");
  });
});
