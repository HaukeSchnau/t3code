import type { WorldRefusal, WorldThreadRepo, WorldThreadStatus } from "@t3tools/contracts";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What a repo holds that no remote has, or null when every remote has it. */
export function worldRepoWork(repo: WorldThreadRepo): string | null {
  const parts = [
    repo.dirty > 0 ? plural(repo.dirty, "changed file", "changed files") : null,
    repo.commits > 0 ? plural(repo.commits, "unpushed commit", "unpushed commits") : null,
    ...repo.branches.map(
      (branch) => `${branch.name}: ${plural(branch.commits, "commit", "commits")} unpushed`,
    ),
    repo.error === undefined ? null : `unreadable: ${repo.error}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The repo's last path segment, which is how people name it. */
export function worldRepoName(repo: WorldThreadRepo): string {
  return repo.dir.split("/").filter(Boolean).at(-1) ?? repo.repo;
}

export function worldRefusalLabel(refusal: WorldRefusal): string {
  return `${refusal.tool} in ${refusal.repo.split("/").at(-1) ?? refusal.repo}: ${refusal.reason}`;
}

/** One line for the world: checkouts and how many of them hold work no remote has. */
export function worldSummary(status: WorldThreadStatus): string {
  if (!status.available) return status.message ?? "The worldfs daemon is not answering";
  const checkedOut = status.repos.filter((repo) => repo.checkedOut).length;
  const withWork = status.repos.filter((repo) => worldRepoWork(repo) !== null).length;
  return [
    checkedOut === 0 ? "Nothing checked out" : `${plural(checkedOut, "repo", "repos")} checked out`,
    withWork === 0 ? null : `${withWork} with unpushed work`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
