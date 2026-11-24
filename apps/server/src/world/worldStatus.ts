// @effect-diagnostics nodeBuiltinImport:off -- repo paths are shown relative to the world.
import * as NodePath from "node:path";

import type { WorldThreadStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Go marshals empty slices as null, so every list accepts it.
const List = <S extends Schema.Top>(item: S) => Schema.NullOr(Schema.Array(item));

/** The daemon's `status` response: `repoStatus` and `refusal` in native/worldfs/ctl.go. */
export const DaemonThreadStatus = Schema.Struct({
  world: Schema.String,
  path: Schema.String,
  repos: List(
    Schema.Struct({
      repo: Schema.String,
      dir: Schema.String,
      state: Schema.String,
      dirty: Schema.Number,
      commits: Schema.Number,
      jjCommits: Schema.Number,
      branches: Schema.optional(
        List(Schema.Struct({ name: Schema.String, commits: Schema.Number })),
      ),
      lostOnTeardown: Schema.Boolean,
      error: Schema.optional(Schema.String),
    }),
  ),
  refusals: List(
    Schema.Struct({
      at: Schema.String,
      repo: Schema.String,
      process: Schema.String,
      reason: Schema.String,
    }),
  ),
});
export type DaemonThreadStatus = typeof DaemonThreadStatus.Type;

export const decodeDaemonThreadStatus = Schema.decodeUnknownEffect(DaemonThreadStatus);

/**
 * What the thread shows: repos it touched, the work only it holds, and the cap's refusals.
 * The daemon names the caller as `<comm>[<pid>]`; a checkout from `serverPid` came from
 * Claude's hook, which runs in this server.
 */
export function toWorldThreadStatus(
  status: DaemonThreadStatus,
  serverPid: number,
): WorldThreadStatus {
  return {
    world: status.world,
    path: status.path,
    available: true,
    repos: (status.repos ?? []).map((repo) => ({
      repo: repo.repo,
      dir: NodePath.relative(status.path, repo.dir) || repo.dir,
      checkedOut: repo.state === "checked-out",
      dirty: repo.dirty,
      commits: repo.commits + repo.jjCommits,
      branches: (repo.branches ?? []).filter((branch) => branch.commits > 0),
      lostOnTeardown: repo.lostOnTeardown,
      ...(repo.error === undefined ? {} : { error: repo.error }),
    })),
    refusals: (status.refusals ?? [])
      .map((refusal) => ({
        at: refusal.at,
        repo: refusal.repo,
        tool: refusal.process.endsWith(`[${serverPid}]`)
          ? "Claude's Bash hook"
          : refusal.process.replace(/\[\d+\]$/, ""),
        reason: refusal.reason,
      }))
      .toReversed(),
  };
}

/** A thread world the daemon has no record of: never launched, or already torn down. */
export function emptyWorldThreadStatus(world: string, path: string): WorldThreadStatus {
  return { world, path, available: true, repos: [], refusals: [] };
}
