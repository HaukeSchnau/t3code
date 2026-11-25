import type { WorldRefusal, WorldThreadRepo, WorldThreadStatus } from "@t3tools/contracts";
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

/** The repo's last path segment, which is how people name it. */
export function worldRepoName(repo: WorldThreadRepo): string {
  return repo.dir.split("/").filter(Boolean).at(-1) ?? repo.repo;
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
