/**
 * The virtual environment: fixture threads presented through the same atoms
 * the sidebar, pickers and monitor already read, including the shell's
 * `coordination` block, so the production lineage selectors, Work panel and
 * Compare surface run unchanged against the scenario.
 *
 * Nothing here gates on a route; the environment exists while the dev flag is
 * on and disappears entirely from production bundles.
 */
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadOrchestrationEffortId,
  ThreadOrchestrationWaitId,
  TurnId,
  type OrchestrationCoordinationShell,
  type OrchestrationLatestTurn,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadRelationshipShell,
  type OrchestrationThreadShell,
  type OrchestrationWaitMemberShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { FIXTURE_ENVIRONMENT_ID, FIXTURE_ENVIRONMENT_LABEL } from "./environmentId";
import type { FixtureProvider, FixtureState, FixtureThread, FixtureThreadStatus } from "./model";
import { displayLabel } from "./presentation";
import { isWaiting } from "./reducer";
import { selectFixtureState, useOrchestrationFixtureStore } from "./store";

export {
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_ENVIRONMENT_LABEL,
  isFixtureEnvironment,
} from "./environmentId";

export function fixtureThreadRef(threadId: string): ScopedThreadRef {
  return { environmentId: FIXTURE_ENVIRONMENT_ID, threadId: ThreadId.make(threadId) };
}

export function fixtureThreadKey(threadId: string): string {
  return scopedThreadKey(fixtureThreadRef(threadId));
}

const PROVIDER_INSTANCE_IDS: Record<FixtureProvider, ProviderInstanceId> = {
  codex: ProviderInstanceId.make("codex"),
  claude: ProviderInstanceId.make("claude"),
  glm: ProviderInstanceId.make("glm"),
};

const TWO_DAYS_MS = 2 * 24 * 60 * 60_000;

function latestTurnFor(thread: FixtureThread): OrchestrationLatestTurn | null {
  if (thread.startedAt === null) return null;
  const state =
    thread.status === "completed"
      ? "completed"
      : thread.status === "failed"
        ? "error"
        : thread.status === "stopped"
          ? "interrupted"
          : "running";
  return {
    turnId: TurnId.make(`${thread.id}:turn`),
    state,
    requestedAt: thread.startedAt,
    startedAt: thread.startedAt,
    completedAt: thread.settledAt,
    assistantMessageId: null,
  };
}

function sessionFor(thread: FixtureThread): OrchestrationSession {
  const status =
    thread.status === "queued"
      ? "starting"
      : thread.status === "running" ||
          thread.status === "blocked-approval" ||
          thread.status === "blocked-input"
        ? "running"
        : thread.status === "failed"
          ? "error"
          : thread.status === "stopped"
            ? "interrupted"
            : "ready";
  return {
    threadId: ThreadId.make(thread.id),
    status,
    providerName: thread.provider,
    providerInstanceId: PROVIDER_INSTANCE_IDS[thread.provider],
    runtimeMode: "auto",
    activeTurnId:
      status === "running" || status === "starting" ? TurnId.make(`${thread.id}:turn`) : null,
    lastError: thread.status === "failed" ? (thread.activity ?? "Turn failed") : null,
    updatedAt: thread.updatedAt,
  };
}

function shellFor(
  state: FixtureState,
  thread: FixtureThread,
  workspaceRoot: string,
): OrchestrationThreadShell {
  const settledLongAgo =
    thread.status === "completed" &&
    thread.settledAt !== null &&
    Date.parse(state.now) - Date.parse(thread.settledAt) > TWO_DAYS_MS;
  return {
    id: ThreadId.make(thread.id),
    projectId: ProjectId.make(thread.projectId),
    title:
      state.delegations[thread.id] === undefined ? thread.title : displayLabel(state, thread.id),
    titleMode: "manual",
    modelSelection: { instanceId: PROVIDER_INSTANCE_IDS[thread.provider], model: thread.model },
    runtimeMode: "auto",
    interactionMode: "default",
    branch: thread.branch,
    worktreePath:
      thread.worktree && thread.branch !== null
        ? `${workspaceRoot}/.t3/worktrees/${thread.branch.replace(/\//g, "-")}`
        : null,
    latestTurn: latestTurnFor(thread),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: settledLongAgo ? thread.settledAt : null,
    pinnedAt: thread.pinnedAt,
    session: sessionFor(thread),
    latestUserMessageAt: thread.latestUserMessageAt,
    hasPendingApprovals: thread.status === "blocked-approval",
    hasPendingUserInput: thread.status === "blocked-input",
    hasActionableProposedPlan: false,
    // A thread idling behind an open wait reads as Monitoring, not Ready.
    backgroundLiveness: isWaiting(state, thread.id) ? "monitoring" : null,
    // The Work row's activity line reads the plan step while a turn runs.
    planProgress:
      thread.status === "running" && thread.activity
        ? { step: thread.activity, completedSteps: 0, totalSteps: 0 }
        : null,
  };
}

function waitOutcome(
  status: FixtureThreadStatus,
): NonNullable<OrchestrationWaitMemberShell["outcome"]> {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "blocked-approval":
      return "blocked-approval";
    case "blocked-input":
      return "blocked-input";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "interrupted";
  }
}

/** The coordination block: relationships, efforts and waits as the server would project them. */
export function buildFixtureCoordination(state: FixtureState): OrchestrationCoordinationShell {
  const ref = (threadId: string) => ({ threadId: ThreadId.make(threadId) });
  const relationships: OrchestrationThreadRelationshipShell[] = [];
  for (const id of state.threadOrder) {
    const delegation = state.delegations[id];
    if (delegation !== undefined) {
      relationships.push({
        kind: "createdBy",
        actor: ref(delegation.parentId),
        target: ref(id),
        label: delegation.label,
        ...(state.threads[id]?.effortId
          ? { effortId: ThreadOrchestrationEffortId.make(state.threads[id]?.effortId ?? "") }
          : {}),
        launchTurnId: null,
        createdAt: delegation.at,
      });
    }
  }
  for (const [oldId, newId] of Object.entries(state.replacements)) {
    relationships.push({
      kind: "replaces",
      actor: ref(newId),
      target: ref(oldId),
      launchTurnId: null,
      createdAt: state.threads[newId]?.createdAt ?? state.now,
    });
  }
  const efforts = state.effortOrder.flatMap((effortId) => {
    const effort = state.efforts[effortId];
    if (effort === undefined) return [];
    return [
      {
        effortId: ThreadOrchestrationEffortId.make(effort.id),
        coordinator: ref(effort.coordinatorId),
        title: effort.title,
        members: effort.members.map((memberId) => ({
          thread: ref(memberId),
          label: displayLabel(state, memberId),
          joinedAt: state.threads[memberId]?.createdAt ?? effort.openedAt,
        })),
        openedAt: effort.openedAt,
        closedAt: effort.closedAt,
      },
    ];
  });
  const waits = Object.values(state.waits).map((wait) => ({
    waitId: ThreadOrchestrationWaitId.make(wait.id),
    coordinator: ref(wait.threadId),
    members: wait.targets.map((targetId) => ({
      thread: ref(targetId),
      outcome: waitOutcome(state.threads[targetId]?.status ?? "queued"),
    })),
    mode: wait.condition,
    state: wait.status,
    openedAt: wait.openedAt,
    deadlineAt: null,
    resolvedAt: wait.resolvedAt,
  }));
  return { relationships, efforts, waits, watches: [] };
}

let snapshotSequence = 0;

/** Builds the shell snapshot the environment atoms serve for the fixture environment. */
export function buildFixtureShellSnapshot(state: FixtureState): OrchestrationShellSnapshot {
  snapshotSequence += 1;
  const rootByProject = new Map(
    state.projects.map((project) => [project.id, project.workspaceRoot]),
  );
  const projects: OrchestrationProjectShell[] = state.projects.map((project) => ({
    id: ProjectId.make(project.id),
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: state.now,
    updatedAt: state.now,
  }));
  const threads = state.threadOrder.flatMap((id) => {
    const thread = state.threads[id];
    if (thread === undefined) return [];
    return [shellFor(state, thread, rootByProject.get(thread.projectId) ?? "/")];
  });
  return {
    snapshotSequence,
    projects,
    threads,
    usageLimits: [],
    coordination: buildFixtureCoordination(state),
    updatedAt: state.now,
  };
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

export const fixtureShellSnapshotAtom = Atom.make<OrchestrationShellSnapshot | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("fixture:orchestration:shell-snapshot"),
);

const FIXTURE_CATALOG_ENTRY = {
  target: new BearerConnectionTarget({
    environmentId: FIXTURE_ENVIRONMENT_ID,
    label: FIXTURE_ENVIRONMENT_LABEL,
    connectionId: "fixture-orchestration",
  }),
  profile: Option.none(),
};

/**
 * Wraps the catalog so the fixture environment appears as one more entry
 * while the fixture is enabled. Pass the result where `catalogValueAtom` is
 * expected by the thread shell, project and presentation atom constructors.
 */
export function withFixtureCatalog(
  base: Atom.Atom<EnvironmentCatalogState>,
): Atom.Atom<EnvironmentCatalogState> {
  return Atom.make((get): EnvironmentCatalogState => {
    const catalog = get(base);
    if (get(fixtureShellSnapshotAtom) === null) return catalog;
    const entries = new Map(catalog.entries);
    entries.set(FIXTURE_ENVIRONMENT_ID, FIXTURE_CATALOG_ENTRY);
    return { isReady: catalog.isReady, entries };
  }).pipe(Atom.withLabel("fixture:orchestration:catalog"));
}

/** Routes the fixture environment id to the fixture snapshot; every other id passes through. */
export function withFixtureSnapshot(
  base: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationShellSnapshot | null>,
): (environmentId: EnvironmentId) => Atom.Atom<OrchestrationShellSnapshot | null> {
  return (environmentId) =>
    environmentId === FIXTURE_ENVIRONMENT_ID ? fixtureShellSnapshotAtom : base(environmentId);
}

let syncStarted = false;

/**
 * Pushes the reduced fixture state into the snapshot atom whenever the store
 * changes. Idempotent; the route module calls it once in dev builds.
 */
export function startFixtureEnvironmentSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  const publish = () => {
    const store = useOrchestrationFixtureStore.getState();
    if (!store.enabled) {
      appAtomRegistry.set(fixtureShellSnapshotAtom, null);
      return;
    }
    appAtomRegistry.set(
      fixtureShellSnapshotAtom,
      buildFixtureShellSnapshot(selectFixtureState(store)),
    );
  };
  publish();
  let previous = useOrchestrationFixtureStore.getState();
  useOrchestrationFixtureStore.subscribe((next) => {
    if (
      next.enabled === previous.enabled &&
      next.cursor === previous.cursor &&
      next.userEvents === previous.userEvents
    ) {
      previous = next;
      return;
    }
    previous = next;
    publish();
  });
}
