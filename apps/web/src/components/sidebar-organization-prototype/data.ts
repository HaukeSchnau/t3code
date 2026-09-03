/**
 * Sample data for the orchestration sidebar prototype. Shapes mirror what the
 * real lineage exposes (parent, effort membership, replacement) without
 * depending on contracts, so the prototype stays isolated from production.
 */

export type WorkerState = "working" | "blocked" | "failed" | "completed" | "stopped" | "idle";

export type ProjectKey = "t3code" | "infra" | "demo" | "casa" | "blx" | "fewo" | "hs";

export interface ProtoProject {
  readonly title: string;
  readonly glyph: string;
  readonly className: string;
}

export const PROJECTS: Record<ProjectKey, ProtoProject> = {
  t3code: {
    title: "T3 Code",
    glyph: "T3",
    className: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
  infra: { title: "infra", glyph: "IN", className: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  demo: {
    title: "orchestration-demo",
    glyph: "OD",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  casa: {
    title: "Casa Crema",
    glyph: "CC",
    className: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  },
  blx: {
    title: "Buildlinx",
    glyph: "BX",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  fewo: {
    title: "fewo-niemann",
    glyph: "FN",
    className: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  },
  hs: {
    title: "haukeschnau",
    glyph: "HS",
    className: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  },
};

export interface ProtoThread {
  readonly id: string;
  readonly title: string;
  readonly project: ProjectKey;
  readonly state: WorkerState;
  /** Completed and not yet visited: shows the emerald Done label. */
  readonly unread: boolean;
  readonly settled: boolean;
  /** The coordinator that created this thread. */
  readonly parentId: string | null;
  readonly effortId: string | null;
  /** The earlier attempt this thread replaces, if it is a retry. */
  readonly replacesId: string | null;
  /** Frozen relative age; the prototype has no clock. */
  readonly age: string;
}

export interface ProtoEffort {
  readonly id: string;
  readonly coordinatorId: string;
  readonly title: string;
  readonly closed: boolean;
}

export interface Scenario {
  readonly threads: ReadonlyArray<ProtoThread>;
  readonly efforts: ReadonlyArray<ProtoEffort>;
}

interface ThreadSeed {
  readonly id: string;
  readonly title: string;
  readonly project: ProjectKey;
  readonly state?: WorkerState;
  readonly unread?: boolean;
  readonly settled?: boolean;
  readonly parentId?: string;
  readonly effortId?: string;
  readonly replacesId?: string;
  readonly age: string;
}

function thread(seed: ThreadSeed): ProtoThread {
  return {
    id: seed.id,
    title: seed.title,
    project: seed.project,
    state: seed.state ?? "idle",
    unread: seed.unread ?? false,
    settled: seed.settled ?? false,
    parentId: seed.parentId ?? null,
    effortId: seed.effortId ?? null,
    replacesId: seed.replacesId ?? null,
    age: seed.age,
  };
}

/** One crowded inbox modelled on the live sidebar. */
export const SAMPLE: Scenario = {
  efforts: [
    { id: "e-rules", coordinatorId: "c-orch", title: "Sidebar rules debate", closed: false },
    { id: "e-adapters", coordinatorId: "c-orch", title: "Provider adapters", closed: true },
    { id: "e-orbit", coordinatorId: "c-orch", title: "Orbit dashboard concepts", closed: true },
    { id: "e-compare", coordinatorId: "c-orch", title: "Compare Orbit variants", closed: true },
    { id: "e-preview", coordinatorId: "c-orch", title: "Preview host access", closed: true },
  ],
  threads: [
    thread({
      id: "t-usage",
      title: "Propagate provider usage limits",
      project: "t3code",
      state: "working",
      age: "4m",
    }),

    // Coordinator with bare children and one superseded attempt.
    thread({
      id: "c-casa",
      title: "Build Five Casa Crema Concepts",
      project: "casa",
      state: "working",
      age: "12m",
    }),
    thread({
      id: "casa-fable",
      title: "Casa Crema · Fable 5.1",
      project: "casa",
      state: "working",
      parentId: "c-casa",
      age: "3m",
    }),
    thread({
      id: "casa-opus",
      title: "Casa Crema · Opus 5",
      project: "casa",
      state: "working",
      parentId: "c-casa",
      age: "3m",
    }),
    thread({
      id: "casa-glm",
      title: "Casa Crema · GLM-5.3-Flash",
      project: "casa",
      state: "completed",
      unread: true,
      parentId: "c-casa",
      age: "9m",
    }),
    thread({
      id: "casa-sol-1",
      title: "Casa Crema · Sol",
      project: "casa",
      state: "failed",
      parentId: "c-casa",
      age: "10m",
    }),
    thread({
      id: "casa-sol-2",
      title: "Casa Crema · Sol · retry",
      project: "casa",
      state: "working",
      parentId: "c-casa",
      replacesId: "casa-sol-1",
      age: "2m",
    }),
    thread({
      id: "casa-genova",
      title: "Casa Crema Genova Website",
      project: "casa",
      state: "blocked",
      parentId: "c-casa",
      age: "6m",
    }),

    // Coordinator with efforts, other delegated work, and past efforts.
    thread({
      id: "c-orch",
      title: "Durable Multi-Thread Orchestration",
      project: "t3code",
      state: "working",
      age: "1h",
    }),
    thread({
      id: "sol-rules",
      title: "Sol · sidebar rules",
      project: "t3code",
      state: "blocked",
      parentId: "c-orch",
      effortId: "e-rules",
      age: "5m",
    }),
    thread({
      id: "fable-rules",
      title: "Fable · sidebar rules",
      project: "t3code",
      state: "working",
      parentId: "c-orch",
      effortId: "e-rules",
      age: "1m",
    }),
    thread({
      id: "mod-rules",
      title: "Debate moderator",
      project: "t3code",
      state: "completed",
      parentId: "c-orch",
      effortId: "e-rules",
      age: "20m",
    }),
    thread({
      id: "ad-codex",
      title: "Codex adapter",
      project: "t3code",
      state: "completed",
      unread: true,
      parentId: "c-orch",
      effortId: "e-adapters",
      age: "40m",
    }),
    thread({
      id: "ad-claude",
      title: "Claude adapter",
      project: "t3code",
      state: "failed",
      parentId: "c-orch",
      effortId: "e-adapters",
      age: "35m",
    }),
    thread({
      id: "ad-opencode",
      title: "OpenCode adapter",
      project: "t3code",
      state: "completed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-adapters",
      age: "50m",
    }),
    thread({
      id: "verify-cli",
      title: "Verify Fable Thread Defaults in CLI",
      project: "t3code",
      state: "working",
      parentId: "c-orch",
      age: "8m",
    }),
    thread({
      id: "verify-cli-a",
      title: "CLI defaults · Codex",
      project: "t3code",
      state: "working",
      parentId: "verify-cli",
      age: "4m",
    }),
    thread({
      id: "verify-cli-b",
      title: "CLI defaults · Claude",
      project: "t3code",
      state: "blocked",
      parentId: "verify-cli",
      age: "6m",
    }),
    thread({
      id: "queued-fix",
      title: "Fix Queued Message History",
      project: "t3code",
      state: "completed",
      parentId: "c-orch",
      age: "2h",
    }),
    thread({
      id: "orbit-fable",
      title: "Orbit · Fable 5.1",
      project: "t3code",
      state: "completed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-orbit",
      age: "2d",
    }),
    thread({
      id: "orbit-opus",
      title: "Orbit · Claude Opus 5",
      project: "t3code",
      state: "completed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-orbit",
      age: "2d",
    }),
    thread({
      id: "orbit-glm-1",
      title: "Orbit · GLM-5.3",
      project: "t3code",
      state: "failed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-orbit",
      age: "2d",
    }),
    thread({
      id: "orbit-glm",
      title: "Orbit · GLM-5.3-Flash",
      project: "t3code",
      state: "completed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-orbit",
      replacesId: "orbit-glm-1",
      age: "2d",
    }),
    thread({
      id: "orbit-sol",
      title: "Orbit · GPT-5.6-Sol",
      project: "t3code",
      state: "completed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-orbit",
      age: "2d",
    }),
    thread({
      id: "cmp-1",
      title: "Compare Orbit Dashboard Variants",
      project: "t3code",
      state: "completed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-compare",
      age: "1d",
    }),
    thread({
      id: "cmp-2",
      title: "Compare Orbit Dashboard Designs",
      project: "t3code",
      state: "completed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-compare",
      age: "1d",
    }),
    thread({
      id: "prev-1",
      title: "Fix Orbit Preview Host Access",
      project: "t3code",
      state: "completed",
      settled: true,
      parentId: "c-orch",
      effortId: "e-preview",
      age: "3d",
    }),
    thread({
      id: "prev-2",
      title: "Fix Vite Preview Host Allowance",
      project: "t3code",
      state: "stopped",
      settled: true,
      parentId: "c-orch",
      effortId: "e-preview",
      age: "3d",
    }),

    // Ordinary threads.
    thread({
      id: "t-glas",
      title: "Glasfasertermin mit Tiefbauer klären",
      project: "hs",
      state: "blocked",
      age: "25m",
    }),
    thread({
      id: "t-fewo",
      title: "Kreative Website für Ferienwohnung",
      project: "fewo",
      state: "completed",
      unread: true,
      age: "1h",
    }),
    thread({
      id: "t-strato",
      title: "Assess Strato Server's Public Roles",
      project: "infra",
      age: "3h",
    }),
    thread({ id: "t-room", title: "Review Roominator Data Structures", project: "blx", age: "5h" }),
    thread({ id: "t-codex", title: "Sync Codex Pause/Resume", project: "t3code", age: "6h" }),

    // Settled top-level history.
    thread({
      id: "s-image",
      title: "Fix Image Message Editing",
      project: "t3code",
      state: "completed",
      settled: true,
      age: "1d",
    }),
    thread({
      id: "s-ci",
      title: "Improve CI Dependency Reliability",
      project: "t3code",
      state: "completed",
      settled: true,
      age: "2d",
    }),
    thread({
      id: "s-defaults",
      title: "Adjust Claude and Fable Defaults",
      project: "t3code",
      state: "completed",
      settled: true,
      age: "2d",
    }),
    thread({
      id: "s-lid",
      title: "Fix Mac Lid-Closed Power Handling",
      project: "infra",
      state: "completed",
      settled: true,
      age: "4d",
    }),
    thread({
      id: "s-devserver",
      title: "Dev-Server für MacBook freigeben",
      project: "fewo",
      state: "completed",
      settled: true,
      age: "5d",
    }),
    thread({
      id: "s-projector",
      title: "Projector Offline Sync Review",
      project: "blx",
      state: "completed",
      settled: true,
      age: "6d",
    }),
  ],
};
