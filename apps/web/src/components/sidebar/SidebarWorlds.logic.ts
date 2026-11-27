import type { ProjectIconColor, ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isPickableProjectMember,
  pickableProjectGroups,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  declaredWorldsFromConfigs,
  fileProjectsIntoWorlds,
  type WorldFiling,
  worldOfScopeKey,
  worldScopeKey,
  worldShortTitle,
} from "@t3tools/client-runtime/state/worlds";

import { deriveProjectIdentity } from "../../projectIdentity";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useProjects, useServerConfigs } from "../../state/entities";

/** Every project filed into its world (patches/worlds.md), from the projects of all machines. */
export function useWorldFiling(): WorldFiling {
  const projects = useProjects();
  const worlds = declaredWorldsFromConfigs(useServerConfigs());
  return fileProjectsIntoWorlds({ projects, worlds });
}

const memberWorlds = (group: SidebarProjectSnapshot, filing: WorldFiling) =>
  group.memberProjectRefs.map(
    (ref) => filing.worldByProjectKey.get(`${ref.environmentId}:${ref.projectId}`) ?? null,
  );

/**
 * Replaces each world scope key with the project groups holding a project filed under that world
 * (or, for the outside, under none), its own project first, so a lens scopes the list, search,
 * drafts and new threads like a chosen project would. narrowToWorldLens then drops the group's
 * other clones.
 */
export function expandWorldScopeKeys(
  keys: ReadonlyArray<string>,
  filing: WorldFiling,
  groups: ReadonlyArray<SidebarProjectSnapshot>,
): ReadonlyArray<string> {
  if (!keys.some((key) => worldOfScopeKey(key) !== undefined)) return keys;
  return keys.flatMap((key) => {
    const world = worldOfScopeKey(key);
    if (world === undefined) return [key];
    return groups
      .filter((group) => memberWorlds(group, filing).includes(world))
      .toSorted((left, right) => Number(right.world != null) - Number(left.world != null))
      .map((group) => group.projectKey);
  });
}

/**
 * Where a new thread under a world lens starts, for the New thread button and its shortcut alike:
 * the world's own open project, not an older one filed under it, on the primary machine if it has
 * one. Null opens the picker; undefined means the lens isn't a world, so the caller's scope
 * decides.
 */
export function worldLensNewThreadProjectRef(input: {
  readonly lensKey: string | null;
  readonly groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "world" | "memberProjects">>;
  readonly primaryEnvironmentId: string | null;
}): ScopedProjectRef | null | undefined {
  const world = input.lensKey === null ? undefined : worldOfScopeKey(input.lensKey);
  if (typeof world !== "string") return undefined;
  const open = input.groups
    .filter((group) => group.world === world)
    .flatMap((group) => group.memberProjects)
    .filter(isPickableProjectMember)
    .toSorted((left, right) =>
      `${left.environmentId}:${left.id}`.localeCompare(`${right.environmentId}:${right.id}`),
    );
  const project =
    open.find((member) => member.environmentId === input.primaryEnvironmentId) ?? open[0];
  return project ? scopeProjectRef(project.environmentId, project.id) : null;
}

/** The persisted scope's world lens, when the scope is exactly one world key. */
export function worldLensKeyOf(keys: ReadonlyArray<string>): string | null {
  return keys.length === 1 && worldOfScopeKey(keys[0]!) !== undefined ? keys[0]! : null;
}

const narrowToWorld = (
  projectKeys: ReadonlySet<string>,
  world: string | null,
  filing: WorldFiling,
): ReadonlySet<string> =>
  new Set([...projectKeys].filter((key) => (filing.worldByProjectKey.get(key) ?? null) === world));

/**
 * A world lens's project keys (`environmentId:projectId`) narrowed to the projects filed under its
 * world: the scope admits whole repository groups, and a repository's clones can sit in
 * different worlds.
 */
export function narrowToWorldLens(
  projectKeys: ReadonlySet<string> | null,
  lensKey: string | null,
  filing: WorldFiling,
): ReadonlySet<string> | null {
  const world = lensKey === null ? undefined : worldOfScopeKey(lensKey);
  return projectKeys === null || world === undefined
    ? projectKeys
    : narrowToWorld(projectKeys, world, filing);
}

export interface SidebarWorldLens {
  readonly id: string;
  readonly title: string;
  readonly label: string;
  readonly project: SidebarProjectSnapshot | null;
  readonly needsYou: number;
}

/**
 * The lenses a sidebar offers: each world, and the outside of every world, that holds a project
 * to scope to, so a pressed lens never stands for nothing and reads as every project.
 */
export function buildWorldLenses(input: {
  readonly filing: WorldFiling;
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  /** The threads the Needs you shelf would list with no scope. */
  readonly needsYou: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>;
}): {
  readonly worlds: ReadonlyArray<SidebarWorldLens>;
  readonly outsideNeedsYou: number | null;
} {
  if (input.filing.worlds.length === 0) return { worlds: [], outsideNeedsYou: null };
  const groups = pickableProjectGroups(input.groups);
  /** How many listed threads in the lens's projects need the user, or null for no projects. */
  const needsYouIn = (world: string | null) => {
    const keys = new Set(expandWorldScopeKeys([worldScopeKey(world)], input.filing, groups));
    if (keys.size === 0) return null;
    const projects = narrowToWorld(
      new Set(
        groups
          .filter((group) => keys.has(group.projectKey))
          .flatMap((group) =>
            group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
          ),
      ),
      world,
      input.filing,
    );
    return input.needsYou.filter((thread) =>
      projects.has(`${thread.environmentId}:${thread.projectId}`),
    ).length;
  };
  return {
    worlds: input.filing.worlds.flatMap((world) => {
      const needsYou = needsYouIn(world.id);
      if (needsYou === null) return [];
      const project = groups.find((group) => group.world === world.id) ?? null;
      return [{ ...world, label: worldShortTitle(world.title), project, needsYou }];
    }),
    outsideNeedsYou: needsYouIn(null),
  };
}

/** The world's color: its project's monogram color, which the world has no other icon for. */
export function worldColor(title: string): ProjectIconColor {
  return deriveProjectIdentity(title).color;
}
