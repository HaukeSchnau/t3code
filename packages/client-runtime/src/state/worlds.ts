import {
  type RepositoryIdentity,
  type ThreadWorldRepo,
  type WorldRefusal,
  type WorldThreadRepo,
  type WorldThreadStatus,
  repositoryGroupingKeyOf,
  worldRepositoryNamespace,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** What a repo holds that no remote has, or null when every remote has it. */
export function worldRepoWork(
  repo: WorldThreadRepo,
  resolve: MFunctionType = mFallback,
): string | null {
  const parts = [
    repo.dirty > 0
      ? resolve(
          msg("{count, plural, one {{count} changed file} other {{count} changed files}}", {
            count: repo.dirty,
          }),
        )
      : null,
    repo.commits > 0
      ? resolve(
          msg("{count, plural, one {{count} unpushed commit} other {{count} unpushed commits}}", {
            count: repo.commits,
          }),
        )
      : null,
    ...repo.branches.map((branch) =>
      resolve(
        msg(
          "{count, plural, one {{branch}: {count} commit unpushed} other {{branch}: {count} commits unpushed}}",
          { branch: branch.name, count: branch.commits },
        ),
      ),
    ),
    repo.error === undefined ? null : resolve(msg("unreadable: {error}", { error: repo.error })),
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

const lastSegment = (path: string) =>
  path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .at(-1);

/** The repo's last path segment, which is how people name it; the world's root goes by its repo. */
export function worldRepoName(
  repo: Pick<WorldThreadRepo | ThreadWorldRepo, "dir" | "repo">,
): string {
  return lastSegment(repo.dir) ?? lastSegment(repo.repo) ?? repo.repo;
}

export function worldRefusalLabel(
  refusal: WorldRefusal,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(
    msg("{tool} in {repo}: {reason}", {
      tool: refusal.tool,
      repo: refusal.repo.split("/").at(-1) ?? refusal.repo,
      reason: refusal.reason,
    }),
  );
}

/** One line for the world: checkouts and how many of them hold work no remote has. */
export function worldSummary(
  status: WorldThreadStatus,
  resolve: MFunctionType = mFallback,
): string {
  if (!status.available) {
    return status.message ?? resolve(msg("The worldfs daemon is not answering"));
  }
  const checkedOut = status.repos.filter((repo) => repo.checkedOut).length;
  const withWork = status.repos.filter((repo) => worldRepoWork(repo) !== null).length;
  return [
    checkedOut === 0
      ? resolve(msg("Nothing checked out"))
      : resolve(
          msg("{count, plural, one {{count} repo checked out} other {{count} repos checked out}}", {
            count: checkedOut,
          }),
        ),
    withWork === 0 ? null : resolve(msg("{count} with unpushed work", { count: withWork })),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The repos as a thread list names them: the first two, then how many more. */
export function threadWorldReposLabel(repos: ReadonlyArray<ThreadWorldRepo>): string {
  const names = repos.slice(0, 2).map(worldRepoName).join(", ");
  return repos.length > 2 ? `${names} +${repos.length - 2}` : names;
}

/** A world's name where worlds sit side by side: "BuildlinX" for "BuildlinX World". */
export function worldShortTitle(title: string): string {
  return title.replace(/\s+world$/i, "");
}

export interface FiledWorld {
  readonly id: string;
  /** The world project's title, such as "BuildlinX World". */
  readonly title: string;
}

/**
 * Which world each project belongs to: a world project to its world, and an older project to the
 * world whose path holds it or whose catalog holds its repository's namespace (patches/worlds.md).
 */
export interface WorldFiling {
  readonly worlds: ReadonlyArray<FiledWorld>;
  /** `environmentId:projectId` → world id. A project missing from it belongs to no world. */
  readonly worldByProjectKey: ReadonlyMap<string, string>;
}

interface FilingProject {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly world?: string | null | undefined;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

const isUnder = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Files projects into worlds. An umbrella such as `~/Buildlinx` joins its world by the world's
 * path, without a remote; another project by its repository's namespace, when one world's catalog
 * holds it and no other's does.
 */
export function fileProjectsIntoWorlds(input: {
  readonly projects: ReadonlyArray<FilingProject>;
  readonly worlds: DeclaredWorlds;
}): WorldFiling {
  const worldByProjectKey = new Map<string, string>();
  const titles = new Map<string, string>();
  for (const project of input.projects) {
    if (project.world == null) continue;
    worldByProjectKey.set(`${project.environmentId}:${project.id}`, project.world);
    if (!titles.has(project.world)) titles.set(project.world, project.title);
  }
  if (titles.size === 0) return { worlds: [], worldByProjectKey };

  for (const project of input.projects) {
    if (project.world != null) continue;
    const paths =
      input.worlds.pathsByEnvironment.get(project.environmentId) ?? input.worlds.anyPaths;
    let world = [...titles.keys()].find((id) => {
      const path = paths.get(id);
      return path !== undefined && isUnder(project.workspaceRoot, path);
    });
    if (world === undefined && project.repositoryIdentity) {
      const namespace = worldRepositoryNamespace(
        repositoryGroupingKeyOf(project.repositoryIdentity),
      );
      const claims = [...(input.worlds.worldsByNamespace.get(namespace) ?? [])];
      if (claims.length === 1 && titles.has(claims[0]!)) world = claims[0];
    }
    if (world !== undefined) worldByProjectKey.set(`${project.environmentId}:${project.id}`, world);
  }
  const worlds = [...titles]
    .map(([id, title]) => ({ id, title }))
    .sort((left, right) => left.title.localeCompare(right.title));
  return { worlds, worldByProjectKey };
}

/** What the servers declare about their worlds. */
export interface DeclaredWorlds {
  /** World id → path, for each server that declares worlds. */
  readonly pathsByEnvironment: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * The first path any server declares for each world, for a server that declares none, such as
   * one not yet set up for worlds.
   */
  readonly anyPaths: ReadonlyMap<string, string>;
  /** Repository namespace → the worlds whose catalogs hold it, on any server. */
  readonly worldsByNamespace: ReadonlyMap<string, ReadonlySet<string>>;
}

export function declaredWorldsFromConfigs(
  configs: ReadonlyMap<
    string,
    {
      readonly settings?: {
        readonly worlds?: Readonly<Record<string, { readonly path: string }>>;
      };
      readonly worldNamespaces?: Readonly<Record<string, ReadonlyArray<string>>>;
    }
  >,
): DeclaredWorlds {
  const pathsByEnvironment = new Map<string, ReadonlyMap<string, string>>();
  const anyPaths = new Map<string, string>();
  const worldsByNamespace = new Map<string, Set<string>>();
  for (const [environmentId, config] of configs) {
    const paths = new Map<string, string>();
    for (const [id, world] of Object.entries(config.settings?.worlds ?? {})) {
      paths.set(id, world.path);
      if (!anyPaths.has(id)) anyPaths.set(id, world.path);
    }
    if (paths.size > 0) pathsByEnvironment.set(environmentId, paths);
    for (const [id, namespaces] of Object.entries(config.worldNamespaces ?? {})) {
      for (const namespace of namespaces) {
        const worlds = worldsByNamespace.get(namespace) ?? new Set();
        worlds.add(id);
        worldsByNamespace.set(namespace, worlds);
      }
    }
  }
  return { pathsByEnvironment, anyPaths, worldsByNamespace };
}

const WORLD_SCOPE_PREFIX = "\0world:";

/**
 * A project scope key standing for every project filed under `world`, or under none for null.
 * A NUL keeps it apart from repository and path keys, as the scratch key does.
 */
export function worldScopeKey(world: string | null): string {
  return `${WORLD_SCOPE_PREFIX}${world ?? ""}`;
}

/** The world a scope key stands for: an id, null for "no world", undefined for other keys. */
export function worldOfScopeKey(key: string): string | null | undefined {
  if (!key.startsWith(WORLD_SCOPE_PREFIX)) return undefined;
  const world = key.slice(WORLD_SCOPE_PREFIX.length);
  return world === "" ? null : world;
}
