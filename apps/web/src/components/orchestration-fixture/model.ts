/**
 * Domain model for the orchestration fixture.
 *
 * Everything durable is a fact the production design would persist on a
 * thread: delegation, handoff and replacement edges, efforts with membership,
 * and waits. Everything else (roll-ups, lineage, lenses) is derived by the
 * reducer's selectors so the UI never stores intent.
 */

export type FixtureProvider = "codex" | "claude" | "glm";

export type FixtureThreadStatus =
  | "queued"
  | "running"
  | "blocked-approval"
  | "blocked-input"
  | "completed"
  | "failed"
  | "stopped";

export const TERMINAL_STATUSES: ReadonlySet<FixtureThreadStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export const BLOCKED_STATUSES: ReadonlySet<FixtureThreadStatus> = new Set([
  "blocked-approval",
  "blocked-input",
]);

export interface FixtureProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface FixtureThreadSeed {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: FixtureProvider;
  readonly model: string;
  readonly branch: string | null;
  readonly worktree: boolean;
}

export interface FixtureChangedFile {
  readonly path: string;
  readonly kind: "modified" | "added" | "deleted";
  readonly additions: number;
  readonly deletions: number;
}

export type FixturePreviewVariant = "nav" | "style";

export interface FixturePreview {
  readonly url: string;
  readonly variant: FixturePreviewVariant;
}

export interface FixtureTerminal {
  readonly label: string;
  readonly lines: ReadonlyArray<string>;
}

export interface FixtureArtifacts {
  readonly answer?: string;
  readonly patch?: string;
  readonly files?: ReadonlyArray<FixtureChangedFile>;
  readonly preview?: FixturePreview;
  readonly terminal?: FixtureTerminal;
}

export interface FixtureDelegation {
  readonly childId: string;
  readonly parentId: string;
  readonly label: string;
  readonly turnId: string;
  readonly at: string;
}

export interface FixtureHandoff {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly text: string;
  readonly at: string;
}

export interface FixtureEffort {
  readonly id: string;
  readonly coordinatorId: string;
  readonly title: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly members: ReadonlyArray<string>;
}

export type FixtureWaitCondition = "all" | "any";

export interface FixtureWait {
  readonly id: string;
  readonly threadId: string;
  readonly targets: ReadonlyArray<string>;
  readonly condition: FixtureWaitCondition;
  readonly openedAt: string;
  readonly status: "open" | "satisfied" | "cancelled";
  readonly resolvedAt: string | null;
}

export type FixtureTimelineItem =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly at: string;
      /** Set when the message arrived from another thread (a handoff). */
      readonly fromId?: string;
    }
  | { readonly kind: "effort"; readonly id: string; readonly effortId: string; readonly at: string }
  | {
      readonly kind: "launch";
      readonly id: string;
      readonly turnId: string;
      readonly childIds: ReadonlyArray<string>;
      readonly at: string;
    }
  | { readonly kind: "wait"; readonly id: string; readonly waitId: string; readonly at: string }
  | {
      readonly kind: "wake";
      readonly id: string;
      readonly text: string;
      readonly sourceIds: ReadonlyArray<string>;
      readonly tone: "info" | "attention";
      readonly at: string;
    }
  | { readonly kind: "note"; readonly id: string; readonly text: string; readonly at: string }
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly text: string;
      readonly resolution: "pending" | "approved" | "denied";
      readonly at: string;
    };

export interface FixtureThread extends FixtureThreadSeed {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: FixtureThreadStatus;
  /** One line, present tense while live, outcome once settled. */
  readonly activity: string | null;
  readonly timeline: ReadonlyArray<FixtureTimelineItem>;
  readonly artifacts: FixtureArtifacts;
  readonly pinnedAt: string | null;
  readonly latestUserMessageAt: string | null;
  readonly startedAt: string | null;
  readonly settledAt: string | null;
  readonly effortId: string | null;
}

export interface FixtureState {
  readonly now: string;
  readonly projects: ReadonlyArray<FixtureProject>;
  readonly threads: Readonly<Record<string, FixtureThread>>;
  readonly threadOrder: ReadonlyArray<string>;
  readonly efforts: Readonly<Record<string, FixtureEffort>>;
  readonly effortOrder: ReadonlyArray<string>;
  readonly waits: Readonly<Record<string, FixtureWait>>;
  readonly delegations: Readonly<Record<string, FixtureDelegation>>;
  readonly handoffs: ReadonlyArray<FixtureHandoff>;
  /** Old thread id to the thread that superseded it. */
  readonly replacements: Readonly<Record<string, string>>;
}

export type FixtureEvent =
  | {
      readonly type: "project.added";
      readonly at: string;
      readonly project: FixtureProject;
    }
  | {
      readonly type: "thread.created";
      readonly at: string;
      readonly thread: FixtureThreadSeed;
      readonly prompt: string;
      readonly status?: FixtureThreadStatus;
      readonly delegation?: {
        readonly parentId: string;
        readonly label: string;
        readonly effortId: string | null;
        readonly turnId: string;
      };
      /** Records a replacement edge from the superseded thread. */
      readonly replaces?: string;
    }
  | {
      readonly type: "thread.status";
      readonly at: string;
      readonly threadId: string;
      readonly status: FixtureThreadStatus;
      readonly activity?: string | null;
    }
  | {
      readonly type: "thread.message";
      readonly at: string;
      readonly threadId: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      /** Handoff: the message was sent by another thread. */
      readonly fromId?: string;
    }
  | {
      readonly type: "thread.artifacts";
      readonly at: string;
      readonly threadId: string;
      readonly artifacts: FixtureArtifacts;
    }
  | { readonly type: "thread.pinned"; readonly at: string; readonly threadId: string }
  | { readonly type: "thread.stopped"; readonly at: string; readonly threadId: string }
  | {
      readonly type: "approval.requested";
      readonly at: string;
      readonly threadId: string;
      readonly text: string;
    }
  | {
      readonly type: "approval.resolved";
      readonly at: string;
      readonly threadId: string;
      readonly approved: boolean;
    }
  | {
      readonly type: "effort.opened";
      readonly at: string;
      readonly effortId: string;
      readonly coordinatorId: string;
      readonly title: string;
    }
  | {
      readonly type: "effort.closed";
      readonly at: string;
      readonly effortId: string;
      readonly stopMembers: boolean;
    }
  | { readonly type: "effort.reopened"; readonly at: string; readonly effortId: string }
  | {
      readonly type: "effort.member.moved";
      readonly at: string;
      readonly threadId: string;
      readonly effortId: string | null;
    }
  | {
      readonly type: "wait.opened";
      readonly at: string;
      readonly waitId: string;
      readonly threadId: string;
      readonly targets: ReadonlyArray<string>;
      readonly condition: FixtureWaitCondition;
    }
  | {
      readonly type: "wait.changed";
      readonly at: string;
      readonly waitId: string;
      readonly condition: FixtureWaitCondition;
    }
  | { readonly type: "wait.cancelled"; readonly at: string; readonly waitId: string }
  | {
      readonly type: "note";
      readonly at: string;
      readonly threadId: string;
      readonly text: string;
    };

export interface FixtureStep {
  readonly caption: string;
  readonly at: string;
  readonly events: ReadonlyArray<FixtureEvent>;
}

export const EMPTY_FIXTURE_STATE: FixtureState = {
  now: "1970-01-01T00:00:00.000Z",
  projects: [],
  threads: {},
  threadOrder: [],
  efforts: {},
  effortOrder: [],
  waits: {},
  delegations: {},
  handoffs: [],
  replacements: {},
};
