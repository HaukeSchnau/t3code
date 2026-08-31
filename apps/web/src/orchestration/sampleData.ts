/**
 * Development-only fixture for the orchestration view.
 *
 * The server side of batches is not on the wire yet, so this stands in for it.
 * It is written in **contract shape** and pushed through `toOrchestrationSnapshot`
 * rather than hand-authored as view models: the page then renders exactly what
 * it will render against a real environment, and any mapping that is wrong here
 * is wrong in production too.
 *
 * It deliberately covers the cases that break naive dashboards:
 *
 * - a satisfied batch with one failed arm, so the comparison shows "2 of 3
 *   approaches worked" instead of a silent "2 approaches";
 * - a live batch whose only actionable member is blocked behind an approval;
 * - a **nested** batch, launched by a worker of another batch, which is what
 *   makes the graph draw a third column instead of a second root;
 * - a batch spanning two hosts whose barrier gave up while a remote arm is
 *   still running and still spending;
 * - one arm sharing the coordinator's checkout instead of taking a worktree.
 *
 * TODO: delete this file once `ThreadOrchestrationBatch` is served and the page
 * reads a real snapshot.
 */
import {
  toOrchestrationSnapshot,
  type BatchContractBatch,
  type BatchContractMember,
  type BatchContractOutcome,
  type BatchContractRelationship,
  type BatchContractThread,
} from "./adapter";
import type { OrchestrationSnapshotWire } from "./model";

const LOCAL_ENVIRONMENT = "env-local-macbook";
const REMOTE_ENVIRONMENT = "env-srv-2";

const ENVIRONMENT_LABELS = new Map([
  [LOCAL_ENVIRONMENT, "MacBook"],
  [REMOTE_ENVIRONMENT, "srv-2"],
]);

const WORKSPACE_ROOT = "/Users/hauke/Code/t3code";

const minutes = (count: number) => count * 60_000;

function at(now: number, minutesAgo: number): string {
  return new Date(now - minutes(minutesAgo)).toISOString();
}

interface WorkerSeed {
  readonly threadId: string;
  readonly label: string;
  readonly title: string;
  readonly outcome: BatchContractOutcome;
  readonly model: string;
  readonly effort?: string;
  readonly environmentId?: string;
  readonly worktree?: string | null;
  readonly startedMinutesAgo: number;
  readonly updatedMinutesAgo: number;
  readonly result?: string;
}

function member(now: number, seed: WorkerSeed): BatchContractMember {
  const environmentId = seed.environmentId ?? LOCAL_ENVIRONMENT;
  const worktreePath =
    seed.worktree === undefined ? `${WORKSPACE_ROOT}-${seed.label}` : seed.worktree;
  const thread: BatchContractThread = {
    environmentId,
    threadId: seed.threadId,
    title: seed.title,
    workspaceRoot: WORKSPACE_ROOT,
    worktreePath,
    outcome: seed.outcome,
    modelSelection: {
      model: seed.model,
      options: seed.effort ? [{ id: "effort", value: seed.effort }] : [],
    },
    createdAt: at(now, seed.startedMinutesAgo),
    updatedAt: at(now, seed.updatedMinutesAgo),
  };
  return {
    label: seed.label,
    workspaceIsolation: worktreePath === null ? "shared" : "worktree",
    thread,
    latestAssistantMessage: seed.result ? { text: seed.result } : null,
  };
}

const COORDINATOR_THREAD = "thread-coordinator-main";
const NESTED_COORDINATOR_THREAD = "thread-auth-risk-first";

function sampleBatches(now: number): readonly BatchContractBatch[] {
  return [
    {
      batchId: "batch_01JCQ7X2K3AUTHREWRITE",
      coordinatorEnvironmentId: LOCAL_ENVIRONMENT,
      coordinatorThreadId: COORDINATOR_THREAD,
      title: "Session auth rewrite — 3 approaches",
      prompt:
        "Replace the cookie session layer with signed tokens. Each arm takes a different risk posture; keep the public API identical and report a diff summary.",
      status: "completed",
      createdAt: at(now, 96),
      deadlineAt: null,
      settledAt: at(now, 21),
      notifiedAt: at(now, 21),
      members: [
        member(now, {
          threadId: NESTED_COORDINATOR_THREAD,
          label: "risk-first",
          title: "Rewrite the session layer, risk-first",
          outcome: "completed",
          model: "claude-opus-5",
          effort: "high",
          startedMinutesAgo: 96,
          updatedMinutesAgo: 21,
          result:
            "Replaced the cookie store with signed tokens and kept a read-only shim for old sessions. Two probe batches confirmed the migration path.",
        }),
        member(now, {
          threadId: "thread-auth-mvp-first",
          label: "mvp-first",
          title: "Rewrite the session layer, smallest change",
          outcome: "completed",
          model: "claude-sonnet-5",
          effort: "medium",
          startedMinutesAgo: 96,
          updatedMinutesAgo: 54,
          result:
            "Kept the cookie transport and swapped only the signing. Smaller diff, but it leaves the rotation problem untouched.",
        }),
        member(now, {
          threadId: "thread-auth-control",
          label: "control",
          title: "Rewrite the session layer, no constraints",
          outcome: "failed",
          model: "claude-opus-5",
          effort: "medium",
          startedMinutesAgo: 96,
          updatedMinutesAgo: 71,
        }),
      ],
    },
    {
      batchId: "batch_01JCQ8B9M4MIGRATIONPROBE",
      coordinatorEnvironmentId: LOCAL_ENVIRONMENT,
      // Launched by a worker of the batch above: the graph's third column.
      coordinatorThreadId: NESTED_COORDINATOR_THREAD,
      title: "Migration probes",
      prompt:
        "Probe whether existing sessions survive the token cutover, on both storage backends.",
      status: "completed",
      createdAt: at(now, 63),
      deadlineAt: null,
      settledAt: at(now, 44),
      notifiedAt: at(now, 44),
      members: [
        member(now, {
          threadId: "thread-probe-sqlite",
          label: "sqlite",
          title: "Probe the SQLite backend",
          outcome: "completed",
          model: "claude-haiku-4-5-20251001",
          startedMinutesAgo: 63,
          updatedMinutesAgo: 51,
          result: "Existing rows decode under the new verifier. No migration needed.",
        }),
        member(now, {
          threadId: "thread-probe-postgres",
          label: "postgres",
          title: "Probe the Postgres backend",
          outcome: "completed",
          model: "claude-haiku-4-5-20251001",
          startedMinutesAgo: 63,
          updatedMinutesAgo: 44,
          result: "Needs a backfill for rows written before the v3 column.",
        }),
      ],
    },
    {
      batchId: "batch_01JCQ9F1P7FLAKYSWEEP",
      coordinatorEnvironmentId: LOCAL_ENVIRONMENT,
      coordinatorThreadId: COORDINATOR_THREAD,
      title: "Flaky test sweep",
      prompt:
        "Find every test that retries in CI and fix it. One arm per package; do not disable tests.",
      status: "blocked",
      createdAt: at(now, 34),
      deadlineAt: null,
      settledAt: null,
      notifiedAt: null,
      members: [
        member(now, {
          threadId: "thread-flaky-server",
          label: "server",
          title: "Fix flaky tests in apps/server",
          outcome: "blocked-approval",
          model: "claude-opus-5",
          effort: "medium",
          startedMinutesAgo: 34,
          updatedMinutesAgo: 12,
        }),
        member(now, {
          threadId: "thread-flaky-web",
          label: "web",
          title: "Fix flaky tests in apps/web",
          outcome: "running",
          model: "claude-sonnet-5",
          effort: "medium",
          startedMinutesAgo: 34,
          updatedMinutesAgo: 1,
        }),
        member(now, {
          threadId: "thread-flaky-mobile",
          label: "mobile",
          title: "Fix flaky tests in apps/mobile",
          outcome: "running",
          model: "claude-sonnet-5",
          effort: "medium",
          environmentId: REMOTE_ENVIRONMENT,
          startedMinutesAgo: 34,
          updatedMinutesAgo: 2,
        }),
        member(now, {
          threadId: "thread-flaky-contracts",
          label: "contracts",
          title: "Fix flaky tests in packages/contracts",
          outcome: "completed",
          model: "claude-sonnet-5",
          effort: "low",
          startedMinutesAgo: 34,
          updatedMinutesAgo: 19,
          result:
            "One test depended on wall-clock ordering. Replaced the sleep with a receipt wait.",
        }),
        member(now, {
          threadId: "thread-flaky-shared",
          label: "shared",
          title: "Fix flaky tests in packages/shared",
          outcome: "queued",
          model: "claude-sonnet-5",
          effort: "low",
          startedMinutesAgo: 34,
          updatedMinutesAgo: 34,
        }),
      ],
    },
    {
      batchId: "batch_01JCQ5T0H2RELEASEAUDIT",
      coordinatorEnvironmentId: LOCAL_ENVIRONMENT,
      coordinatorThreadId: COORDINATOR_THREAD,
      title: "Release audit — two hosts",
      prompt: "Audit the release branch for regressions. Run the mobile arm on srv-2.",
      status: "deadline-exceeded",
      createdAt: at(now, 220),
      deadlineAt: at(now, 40),
      settledAt: at(now, 40),
      notifiedAt: at(now, 40),
      members: [
        member(now, {
          threadId: "thread-audit-desktop",
          label: "desktop",
          title: "Audit the desktop build",
          outcome: "completed",
          model: "claude-opus-5",
          effort: "high",
          startedMinutesAgo: 220,
          updatedMinutesAgo: 132,
          result: "No regressions. One packaging warning worth a follow-up.",
        }),
        member(now, {
          threadId: "thread-audit-web",
          label: "web",
          title: "Audit the web bundle",
          outcome: "completed",
          model: "claude-opus-5",
          effort: "high",
          // Shares the coordinator's checkout: the badge for this is the point.
          worktree: null,
          startedMinutesAgo: 220,
          updatedMinutesAgo: 150,
          result: "Bundle grew 4%. Traced to the new theme table; acceptable.",
        }),
        member(now, {
          threadId: "thread-audit-mobile",
          label: "mobile",
          title: "Audit the mobile release",
          // The barrier gave up; this arm is on another host and never stopped.
          outcome: "running",
          model: "claude-opus-5",
          effort: "high",
          environmentId: REMOTE_ENVIRONMENT,
          startedMinutesAgo: 220,
          updatedMinutesAgo: 3,
        }),
      ],
    },
  ];
}

function coordinatorThread(now: number, threadId: string, title: string): BatchContractThread {
  return {
    environmentId: LOCAL_ENVIRONMENT,
    threadId,
    title,
    workspaceRoot: WORKSPACE_ROOT,
    worktreePath: null,
    outcome: "running",
    modelSelection: { model: "claude-opus-5", options: [{ id: "effort", value: "high" }] },
    createdAt: at(now, 240),
    updatedAt: at(now, 1),
  };
}

function sampleRelationships(now: number): readonly BatchContractRelationship[] {
  const createdBy = (
    actorThreadId: string,
    targetThreadId: string,
    batchId: string,
    minutesAgo: number,
    targetEnvironmentId = LOCAL_ENVIRONMENT,
  ): BatchContractRelationship => ({
    kind: "createdBy",
    actorEnvironmentId: LOCAL_ENVIRONMENT,
    actorThreadId,
    targetEnvironmentId,
    targetThreadId,
    batchId,
    createdAt: at(now, minutesAgo),
  });

  return [
    createdBy(COORDINATOR_THREAD, NESTED_COORDINATOR_THREAD, "batch_01JCQ7X2K3AUTHREWRITE", 96),
    createdBy(COORDINATOR_THREAD, "thread-auth-mvp-first", "batch_01JCQ7X2K3AUTHREWRITE", 96),
    createdBy(COORDINATOR_THREAD, "thread-auth-control", "batch_01JCQ7X2K3AUTHREWRITE", 96),
    createdBy(
      NESTED_COORDINATOR_THREAD,
      "thread-probe-sqlite",
      "batch_01JCQ8B9M4MIGRATIONPROBE",
      63,
    ),
    createdBy(
      NESTED_COORDINATOR_THREAD,
      "thread-probe-postgres",
      "batch_01JCQ8B9M4MIGRATIONPROBE",
      63,
    ),
    {
      kind: "messagedBy",
      actorEnvironmentId: LOCAL_ENVIRONMENT,
      actorThreadId: NESTED_COORDINATOR_THREAD,
      targetEnvironmentId: LOCAL_ENVIRONMENT,
      targetThreadId: COORDINATOR_THREAD,
      createdAt: at(now, 22),
    },
    {
      kind: "readBy",
      actorEnvironmentId: LOCAL_ENVIRONMENT,
      actorThreadId: "thread-flaky-web",
      targetEnvironmentId: LOCAL_ENVIRONMENT,
      targetThreadId: "thread-auth-mvp-first",
      createdAt: at(now, 8),
    },
    {
      // Dropped by the adapter: a rename is neither provenance nor a message.
      kind: "renamedBy",
      actorEnvironmentId: LOCAL_ENVIRONMENT,
      actorThreadId: COORDINATOR_THREAD,
      targetEnvironmentId: LOCAL_ENVIRONMENT,
      targetThreadId: "thread-flaky-shared",
      createdAt: at(now, 30),
    },
  ];
}

/** Everything the page needs, mapped through the real adapter. */
export function buildSampleOrchestrationSnapshot(now: number): OrchestrationSnapshotWire {
  const batches = sampleBatches(now);
  return toOrchestrationSnapshot({
    batches,
    graph: {
      nodes: [
        coordinatorThread(now, COORDINATOR_THREAD, "Ship the auth rewrite"),
        ...batches.flatMap((batch) => batch.members.map((entry) => entry.thread)),
      ],
      edges: sampleRelationships(now),
    },
    environmentLabels: ENVIRONMENT_LABELS,
    localEnvironmentId: LOCAL_ENVIRONMENT,
  });
}
