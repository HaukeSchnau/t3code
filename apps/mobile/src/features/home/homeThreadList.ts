import {
  buildProjectGroups,
  pickableProjectGroups,
  resolveScratchProjectScopeKey,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  getThreadSortTimestamp,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
} from "@t3tools/contracts";
import {
  type WorldFiling,
  worldOfScopeKey,
  worldScopeKey,
} from "@t3tools/client-runtime/state/worlds";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

export type HomeProjectSortOrder = Exclude<SidebarProjectSortOrder, "manual">;

export interface HomeProjectScope {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly pinned: boolean;
  readonly archived: boolean;
}

function getProjectSortTimestamp(
  project: EnvironmentProject,
  sortOrder: HomeProjectSortOrder,
): number {
  return sortOrder === "created_at"
    ? (toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY)
    : (toSortableTimestamp(project.updatedAt) ??
        toSortableTimestamp(project.createdAt) ??
        Number.NEGATIVE_INFINITY);
}

export function buildHomeProjectScopes(
  input: {
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly environmentId: EnvironmentId | null;
    readonly projectGroupingMode: SidebarProjectGroupingMode;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<HomeProjectScope> {
  const projects = input.projects.filter(
    (project) => input.environmentId === null || project.environmentId === input.environmentId,
  );
  return buildProjectGroups(
    {
      projects,
      groupScratchProjects: true,
      settings: {
        sidebarProjectGroupingMode: input.projectGroupingMode,
        sidebarProjectGroupingOverrides: {},
      },
    },
    resolve,
  ).map((group) => {
    return {
      key: group.key,
      title: group.label,
      representative: group.representative,
      projects: group.members.map((member) => member.project),
      projectRefs: group.memberProjectRefs,
      pinned: group.pinned,
      archived: group.archived,
    };
  });
}

/** The scope the thread list's project filter shows; an archived or unknown key shows all projects. */
export function resolveHomeProjectFilterScope(
  scopes: ReadonlyArray<HomeProjectScope>,
  projects: ReadonlyArray<EnvironmentProject>,
  options: {
    readonly selectedProjectKey: string | null;
    readonly projectGroupingMode: SidebarProjectGroupingMode;
  },
  filing?: WorldFiling,
  resolve: MessageResolver = m,
): HomeProjectScope | null {
  if (filing !== undefined && options.selectedProjectKey !== null) {
    if (worldOfScopeKey(options.selectedProjectKey) !== undefined) {
      return (
        buildHomeWorldScopes(scopes, filing, resolve).find(
          (scope) => scope.key === options.selectedProjectKey,
        ) ?? null
      );
    }
  }
  // A legacy per-environment scratch key resolves here; the stored value is only
  // rewritten when the user picks a filter.
  const key = resolveScratchProjectScopeKey(options.selectedProjectKey, projects, {
    sidebarProjectGroupingMode: options.projectGroupingMode,
    sidebarProjectGroupingOverrides: {},
  });
  return pickableProjectGroups(scopes).find((scope) => scope.key === key) ?? null;
}

export function findHomeProjectScope(
  scopes: ReadonlyArray<HomeProjectScope>,
  key: string | null,
): HomeProjectScope | null {
  if (key === null) {
    return null;
  }
  return (
    scopes.find((scope) => scope.key === key) ??
    scopes.find((scope) =>
      scope.projectRefs.some(
        (projectRef) => scopedProjectKey(projectRef.environmentId, projectRef.projectId) === key,
      ),
    ) ??
    null
  );
}

export function sortHomeProjectScopes(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly projectSortOrder: HomeProjectSortOrder;
}): ReadonlyArray<HomeProjectScope> {
  const scopeKeyByProjectRef = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [scopedProjectKey(projectRef.environmentId, projectRef.projectId), scope.key] as const,
      ),
    ),
  );
  const latestActivityByScope = new Map<string, number>();
  const recordActivity = (scopeKey: string | undefined, timestamp: number) => {
    if (!scopeKey || !Number.isFinite(timestamp)) return;
    latestActivityByScope.set(
      scopeKey,
      Math.max(latestActivityByScope.get(scopeKey) ?? Number.NEGATIVE_INFINITY, timestamp),
    );
  };

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(thread.environmentId, thread.projectId)),
      getThreadSortTimestamp(thread, input.projectSortOrder),
    );
  }
  for (const pendingTask of input.pendingTasks) {
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(pendingTask.environmentId, pendingTask.projectId)),
      Date.parse(pendingTask.createdAt),
    );
  }

  return Arr.sort(
    input.scopes,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (scope: HomeProjectScope) => ({
        timestamp:
          latestActivityByScope.get(scope.key) ??
          Math.max(
            ...scope.projects.map((project) =>
              getProjectSortTimestamp(project, input.projectSortOrder),
            ),
          ),
        title: scope.title,
        key: scope.key,
      }),
    ),
  );
}

/**
 * A filter scope per world, and one for threads in no world, each merging the project scopes
 * filed there (patches/worlds.md), so the list's project filter can stand for a whole world.
 */
export function buildHomeWorldScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  filing: WorldFiling,
  resolve: MessageResolver = m,
): ReadonlyArray<HomeProjectScope> {
  if (filing.worlds.length === 0) return [];
  // Each ref by its own filing: a repository's clones can sit in different worlds.
  const worldOf = (environmentId: string, projectId: string) =>
    filing.worldByProjectKey.get(`${environmentId}:${projectId}`) ?? null;
  const live = scopes.filter((scope) => !scope.archived);
  const buckets: ReadonlyArray<{ readonly id: string | null; readonly title: string }> = [
    ...filing.worlds,
    { id: null, title: resolve(msg("Outside worlds")) },
  ];
  return buckets.flatMap(({ id, title }) => {
    const members = live.filter((scope) =>
      scope.projectRefs.some((ref) => worldOf(ref.environmentId, ref.projectId) === id),
    );
    if (members.length === 0) return [];
    const projectRefs = members.flatMap((scope) =>
      scope.projectRefs.filter((ref) => worldOf(ref.environmentId, ref.projectId) === id),
    );
    const projects = members.flatMap((scope) =>
      scope.projects.filter((project) => worldOf(project.environmentId, project.id) === id),
    );
    return [
      {
        key: worldScopeKey(id),
        title,
        representative:
          projects.find((project) => project.world != null) ??
          projects[0] ??
          members[0]!.representative,
        projects,
        projectRefs,
        pinned: false,
        archived: false,
      },
    ];
  });
}
