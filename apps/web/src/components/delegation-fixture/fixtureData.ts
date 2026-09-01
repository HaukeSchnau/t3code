/**
 * Static data for the delegation fixture at `/fixtures/delegation`.
 *
 * Everything the wire already carries is built as a real
 * `ThreadOrchestrationBatch`, so the fixture components consume the same shape
 * a live batch will hand them. Everything the wire does *not* carry yet — the
 * one-line activity, the frozen elapsed strings, the per-worker verdict, diff
 * stats and compare payloads — sits beside it on `DelegationWorkerView` where
 * it is obviously presentation.
 *
 * Nothing here ticks. Elapsed values are frozen strings and every timestamp is
 * a literal, so the fixture repaints only when the reviewer moves a control.
 */
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadOrchestrationBatchId,
  type ModelSelection,
  type OrchestrationMessage,
  type ThreadOrchestrationBatch,
  type ThreadOrchestrationBatchMember,
  type ThreadOrchestrationThreadSummary,
} from "@t3tools/contracts";

export const DELEGATION_PHASES = ["launched", "running", "settled"] as const;
export type DelegationPhase = (typeof DELEGATION_PHASES)[number];

export const DELEGATION_PHASE_LABELS: Record<DelegationPhase, string> = {
  launched: "Launched",
  running: "Running",
  settled: "Settled",
};

export function isDelegationPhase(value: string): value is DelegationPhase {
  return DELEGATION_PHASES.some((phase) => phase === value);
}

/** Which provider mark a lane draws. GLM ships no mark, so it gets a monogram. */
export type DelegationGlyph = "codex" | "claude" | "glm";

export type DelegationVerdict = "accepted" | "partial" | "rejected";

/** What a settled worker handed back. Bounded on purpose: three short sections. */
export interface DelegationResult {
  readonly verdict: DelegationVerdict;
  /** Strip column, e.g. `12/12 passed`. */
  readonly tests: string;
  readonly additions: number;
  readonly deletions: number;
  readonly answer: string;
  readonly diff: string;
  readonly testOutput: string;
}

export interface DelegationWorkerView {
  readonly key: string;
  readonly label: string;
  readonly glyph: DelegationGlyph;
  readonly member: ThreadOrchestrationBatchMember;
  /** One line. Present tense while the worker is live, outcome once settled. */
  readonly activity: string;
  readonly elapsed: string;
  /** The worker's question, verbatim, while it is blocked on review. */
  readonly reviewRequest: string | null;
  readonly result: DelegationResult | null;
}

export interface DelegationCounts {
  readonly starting: number;
  readonly running: number;
  readonly needsReview: number;
  readonly settled: number;
}

export interface DelegationFixtureState {
  readonly phase: DelegationPhase;
  readonly task: string;
  readonly batch: ThreadOrchestrationBatch;
  readonly workers: readonly DelegationWorkerView[];
  readonly counts: DelegationCounts;
  /** Batch elapsed, frozen. */
  readonly elapsed: string;
  /** The coordinator's ordinary assistant message, rendered after the row. */
  readonly assessment: string | null;
}

const ENVIRONMENT_ID = EnvironmentId.make("env-local");
const PROJECT_ID = ProjectId.make("project-t3code");
const BATCH_ID = ThreadOrchestrationBatchId.make("thread-orchestration:batch:01JD3F9K2XCHECKPOINT");
const COORDINATOR_THREAD_ID = ThreadId.make("thread-coordinator-checkpoint");
const WORKSPACE_ROOT = "/Users/hauke/Code/t3code";

export const DELEGATION_TASK = "Fix flaky checkpoint restore test";

export const DELEGATION_PROMPT =
  "apps/server/test/checkpoint.test.ts flakes about one run in five on CI. Fan it out to Codex, Claude and GLM in separate worktrees, then tell me which fix to take.";

const BATCH_PROMPT =
  "Find and fix the race behind the flaky checkpoint restore test. Keep the fix minimal and do not paper over it with a retry or a sleep.";

const CREATED_AT = "2026-02-11T09:14:00.000Z";
const LAUNCHED_AT = "2026-02-11T09:14:04.000Z";
const RUNNING_AT = "2026-02-11T09:18:12.000Z";
const SETTLED_AT = "2026-02-11T09:20:31.000Z";

interface WorkerSeed {
  readonly key: string;
  readonly label: string;
  readonly glyph: DelegationGlyph;
  readonly instanceId: string;
  readonly model: string;
  readonly threadTitle: string;
  readonly outcome: ThreadOrchestrationBatchMember["outcome"];
  readonly activity: string;
  readonly elapsed: string;
  readonly reviewRequest?: string;
  readonly latestAssistantText?: string;
  readonly result?: DelegationResult;
}

function modelSelection(seed: WorkerSeed): ModelSelection {
  return { instanceId: ProviderInstanceId.make(seed.instanceId), model: seed.model };
}

function threadSummary(seed: WorkerSeed, updatedAt: string): ThreadOrchestrationThreadSummary {
  return {
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make(`thread-${seed.key}-checkpoint`),
    projectId: PROJECT_ID,
    title: seed.threadTitle,
    projectTitle: "t3code",
    status: seed.outcome,
    modelSelection: modelSelection(seed),
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceRoot: WORKSPACE_ROOT,
    worktreePath: `${WORKSPACE_ROOT}-${seed.key}`,
    outcome: seed.outcome,
    createdAt: CREATED_AT,
    updatedAt,
  };
}

function latestAssistantMessage(seed: WorkerSeed, updatedAt: string): OrchestrationMessage | null {
  if (seed.latestAssistantText === undefined) {
    return null;
  }
  return {
    id: MessageId.make(`message-${seed.key}-latest`),
    role: "assistant",
    text: seed.latestAssistantText,
    turnId: null,
    streaming: false,
    createdAt: updatedAt,
    updatedAt,
  };
}

function member(seed: WorkerSeed, updatedAt: string): ThreadOrchestrationBatchMember {
  return {
    label: seed.label,
    workspaceIsolation: "worktree",
    outcome: seed.outcome,
    thread: threadSummary(seed, updatedAt),
    latestAssistantMessage: latestAssistantMessage(seed, updatedAt),
    // The fixture never queues follow-ups; the blocked worker is waiting on the
    // user, not on a backlog of its own.
    queuedMessageCount: 0,
  };
}

function worker(seed: WorkerSeed, updatedAt: string): DelegationWorkerView {
  return {
    key: seed.key,
    label: seed.label,
    glyph: seed.glyph,
    member: member(seed, updatedAt),
    activity: seed.activity,
    elapsed: seed.elapsed,
    reviewRequest: seed.reviewRequest ?? null,
    result: seed.result ?? null,
  };
}

function countWorkers(workers: readonly DelegationWorkerView[]): DelegationCounts {
  let starting = 0;
  let running = 0;
  let needsReview = 0;
  let settled = 0;
  for (const entry of workers) {
    switch (entry.member.outcome) {
      case "unknown":
      case "queued":
        starting += 1;
        break;
      case "running":
        running += 1;
        break;
      case "blocked-approval":
      case "blocked-input":
        needsReview += 1;
        break;
      case "completed":
      case "failed":
      case "interrupted":
        settled += 1;
        break;
    }
  }
  return { starting, running, needsReview, settled };
}

/**
 * The one count phrase the row is allowed to show. It is the only mutable text
 * in the timeline besides elapsed, so it stays a single joined clause.
 */
export function delegationCountsLabel(counts: DelegationCounts): string {
  const parts: string[] = [];
  if (counts.starting > 0) parts.push(`${counts.starting} starting`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.needsReview > 0) parts.push(`${counts.needsReview} needs review`);
  if (counts.settled > 0) {
    parts.push(`${counts.settled} result${counts.settled === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function buildState(input: {
  readonly phase: DelegationPhase;
  readonly status: ThreadOrchestrationBatch["status"];
  readonly updatedAt: string;
  readonly settledAt: string | null;
  readonly elapsed: string;
  readonly seeds: readonly WorkerSeed[];
  readonly assessment?: string;
}): DelegationFixtureState {
  const workers = input.seeds.map((seed) => worker(seed, input.updatedAt));
  return {
    phase: input.phase,
    task: DELEGATION_TASK,
    batch: {
      batchId: BATCH_ID,
      coordinatorEnvironmentId: ENVIRONMENT_ID,
      coordinatorThreadId: COORDINATOR_THREAD_ID,
      title: DELEGATION_TASK,
      prompt: BATCH_PROMPT,
      status: input.status,
      members: workers.map((entry) => entry.member),
      createdAt: CREATED_AT,
      deadlineAt: null,
      settledAt: input.settledAt,
      notifiedAt: input.settledAt,
    },
    workers,
    counts: countWorkers(workers),
    elapsed: input.elapsed,
    assessment: input.assessment ?? null,
  };
}

const CODEX_RESULT: DelegationResult = {
  verdict: "accepted",
  tests: "12/12 passed",
  additions: 38,
  deletions: 12,
  answer:
    "The ref read races the ref write: restore resolves refs/t3/checkpoint/<turn> before the checkpoint reactor has finished writing it. I read the ref once, under the same lock the writer takes, and fail with CheckpointRefMissing when it is genuinely absent. No retry loop, no sleep.",
  diff: `apps/server/src/checkpoint/restore.ts
-  const ref = yield* readRef(refName)
-  if (ref === null) return yield* retryRestore(turnId)
+  const ref = yield* withCheckpointLock(turnId, readRef(refName))
+  if (ref === null) return yield* new CheckpointRefMissing({ turnId })`,
  testOutput: `vp test run apps/server/test/checkpoint.test.ts
 ✓ restores the working tree from a turn checkpoint
 ✓ fails loudly when the checkpoint ref is missing
 ✓ restores after a concurrent checkpoint write
 12 passed (12)`,
};

const CLAUDE_RESULT: DelegationResult = {
  verdict: "partial",
  tests: "11/12 passed",
  additions: 21,
  deletions: 4,
  answer:
    "Same race. I think failing loudly is right — a silent fallback restores the wrong turn — so I asked before choosing. While the question was open I shipped the fallback to keep the suite green, which is why the loud-failure test is red.",
  diff: `apps/server/src/checkpoint/restore.ts
-  const ref = yield* readRef(refName)
+  const ref = (yield* readRef(refName)) ?? (yield* readRef(previousRefName))
+  if (ref === null) return yield* new CheckpointRefMissing({ turnId })`,
  testOutput: `vp test run apps/server/test/checkpoint.test.ts
 ✓ restores the working tree from a turn checkpoint
 ✗ fails loudly when the checkpoint ref is missing
     expected CheckpointRefMissing, restored turn 41
 11 passed (12), 1 failed`,
};

const GLM_RESULT: DelegationResult = {
  verdict: "rejected",
  tests: "9/12 passed",
  additions: 64,
  deletions: 31,
  answer:
    "Rebuilt restore around an explicit state machine — Resolving, Reading, Applying — with a bounded backoff between states. The race is gone, but the whole restore path went with it and three unrelated cases regressed.",
  diff: `apps/server/src/checkpoint/restore.ts
-  export const restore = (turnId: TurnId) => ...
+  const RETRY_BACKOFF_MS = [25, 50, 100]
+  class CheckpointRestoreMachine { ... }
+  export const restore = (turnId: TurnId) => machine.run(turnId)`,
  testOutput: `vp test run apps/server/test/checkpoint.test.ts
 ✓ restores the working tree from a turn checkpoint
 ✗ fails loudly when the checkpoint ref is missing
 ✗ restores after a concurrent checkpoint write
 ✗ leaves the worktree untouched on failure
 9 passed (12), 3 failed`,
};

const CODEX_BASE = {
  key: "codex",
  label: "Codex",
  glyph: "codex",
  instanceId: "codex",
  model: "gpt-5.2-codex",
  threadTitle: "Fix flaky checkpoint restore test — Codex",
} as const satisfies Partial<WorkerSeed>;

const CLAUDE_BASE = {
  key: "claude",
  label: "Claude",
  glyph: "claude",
  instanceId: "claude",
  model: "claude-opus-5",
  threadTitle: "Fix flaky checkpoint restore test — Claude",
} as const satisfies Partial<WorkerSeed>;

const GLM_BASE = {
  key: "glm",
  label: "GLM",
  glyph: "glm",
  instanceId: "opencode",
  model: "zai-coding-plan/glm-5.2",
  threadTitle: "Fix flaky checkpoint restore test — GLM",
} as const satisfies Partial<WorkerSeed>;

const LAUNCHED = buildState({
  phase: "launched",
  status: "running",
  updatedAt: LAUNCHED_AT,
  settledAt: null,
  elapsed: "0:04",
  seeds: [
    { ...CODEX_BASE, outcome: "queued", activity: "Starting…", elapsed: "0:04" },
    { ...CLAUDE_BASE, outcome: "queued", activity: "Starting…", elapsed: "0:04" },
    { ...GLM_BASE, outcome: "queued", activity: "Starting…", elapsed: "0:04" },
  ],
});

const RUNNING = buildState({
  phase: "running",
  status: "blocked",
  updatedAt: RUNNING_AT,
  settledAt: null,
  elapsed: "4:12",
  seeds: [
    {
      ...CODEX_BASE,
      outcome: "running",
      activity: "Editing apps/server/src/checkpoint/restore.ts",
      elapsed: "4:12",
    },
    {
      ...CLAUDE_BASE,
      outcome: "blocked-input",
      activity: "Needs review",
      elapsed: "4:12",
      reviewRequest:
        "Should restore fall back to the previous checkpoint when the ref is missing, or fail loudly?",
    },
    {
      ...GLM_BASE,
      outcome: "running",
      activity: "Running vp test run apps/server/test/checkpoint.test.ts",
      elapsed: "4:08",
    },
  ],
});

const SETTLED = buildState({
  phase: "settled",
  status: "completed",
  updatedAt: SETTLED_AT,
  settledAt: SETTLED_AT,
  elapsed: "6:31",
  seeds: [
    {
      ...CODEX_BASE,
      outcome: "completed",
      activity: "Accepted · 12/12 passed",
      elapsed: "6:12",
      latestAssistantText: CODEX_RESULT.answer,
      result: CODEX_RESULT,
    },
    {
      ...CLAUDE_BASE,
      outcome: "completed",
      activity: "Partial · 11/12 passed",
      elapsed: "5:48",
      latestAssistantText: CLAUDE_RESULT.answer,
      result: CLAUDE_RESULT,
    },
    {
      ...GLM_BASE,
      outcome: "completed",
      activity: "Rejected · 9/12 passed",
      elapsed: "6:31",
      latestAssistantText: GLM_RESULT.answer,
      result: GLM_RESULT,
    },
  ],
  assessment:
    "Codex's fix is the one to take. It removes the race at the ref-read rather than retrying around it, and it's the only version where the test passes without a sleep. Claude asked the right question — fail loudly is correct — but shipped the fallback anyway. GLM's diff rewrites the restore path wholesale for a one-line bug.",
});

export const DELEGATION_FIXTURE_STATES: Record<DelegationPhase, DelegationFixtureState> = {
  launched: LAUNCHED,
  running: RUNNING,
  settled: SETTLED,
};

/** Compare opens on the first two workers until the reviewer picks otherwise. */
export const DEFAULT_COMPARE_KEYS: readonly string[] = ["codex", "claude"];
