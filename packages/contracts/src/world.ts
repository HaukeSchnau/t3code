import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A world's name in the machine cache, such as `buildlinx` (`/var/lib/worlds/<id>`). */
export const WorldId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/));
export type WorldId = typeof WorldId.Type;

export const WorldSettings = Schema.Struct({
  title: TrimmedNonEmptyString,
  /** Where every thread of the world sees it, such as `/home/haukeschnau/Buildlinx`. */
  path: TrimmedNonEmptyString.check(Schema.isPattern(/^\//)),
  /**
   * The world repo, cloned as each thread world's root: instructions, notes, and the layout in
   * its `world.json`. T3 pushes the thread's note changes at the end of each turn.
   */
  repo: Schema.optional(TrimmedNonEmptyString),
  /** Host paths every thread of the world reads at the same path, read-only. */
  mounts: Schema.Array(TrimmedNonEmptyString.check(Schema.isPattern(/^\//))).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type WorldSettings = typeof WorldSettings.Type;

/**
 * A repository's namespace, its forge and owner, such as `git.buildlinx.io/buildlinx` for
 * `git.buildlinx.io/buildlinx/cloud/frontend`. Clients file older projects by it.
 */
export function worldRepositoryNamespace(repository: string): string {
  return repository.split("/").slice(0, 2).join("/").toLowerCase();
}

export const WorldRepoBranch = Schema.Struct({
  name: Schema.String,
  /** Commits on the branch that no remote has. */
  commits: NonNegativeInt,
});
export type WorldRepoBranch = typeof WorldRepoBranch.Type;

/** One repo the thread touched, and what it holds that no remote has. */
export const WorldThreadRepo = Schema.Struct({
  repo: Schema.String,
  /** Path inside the world, such as `Repos/cloud/frontend`. */
  dir: Schema.String,
  checkedOut: Schema.Boolean,
  /** Changed, staged or untracked files. */
  dirty: NonNegativeInt,
  /** Git and jj commits only this thread has. */
  commits: NonNegativeInt,
  /** Local branches in the shared mirror with commits no remote has; they survive teardown. */
  branches: Schema.Array(WorldRepoBranch),
  /** Removing the thread world now would lose work. */
  lostOnTeardown: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type WorldThreadRepo = typeof WorldThreadRepo.Type;

/** A repo a thread checked out in its world, kept on the thread after its world is gone. */
export const ThreadWorldRepo = Schema.Struct({
  /** The world's catalog name, such as `git.buildlinx.io/buildlinx/cloud/frontend`. */
  repo: Schema.String,
  /** Path inside the world, such as `Repos/buildlinx/cloud/frontend`. */
  dir: Schema.String,
  /** It held work no remote has when T3 last looked. */
  work: Schema.Boolean,
});
export type ThreadWorldRepo = typeof ThreadWorldRepo.Type;

/** A write or checkout the cap refused. */
export const WorldRefusal = Schema.Struct({
  at: Schema.String,
  repo: Schema.String,
  /** The process that tried, such as `pnpm` or `claude`. */
  tool: Schema.String,
  reason: Schema.String,
});
export type WorldRefusal = typeof WorldRefusal.Type;

export const WorldThreadStatus = Schema.Struct({
  world: Schema.String,
  /** The world's path inside the thread. */
  path: Schema.String,
  repos: Schema.Array(WorldThreadRepo),
  refusals: Schema.Array(WorldRefusal),
  /** False when the daemon could not be asked; `message` then says why. */
  available: Schema.Boolean,
  message: Schema.optional(Schema.String),
});
export type WorldThreadStatus = typeof WorldThreadStatus.Type;
