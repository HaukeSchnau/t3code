import { Effect, Layer } from "effect";
import { GitCommandError } from "@t3tools/contracts";

import { GitCore } from "../Services/GitCore.ts";
import { JjCore } from "../Services/JjCore.ts";
import { RepositoryVcs, type RepositoryVcsShape } from "../Services/RepositoryVcs.ts";

export const RepositoryVcsLive = Layer.effect(
  RepositoryVcs,
  Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const jjCore = yield* JjCore;

    const useJj = (cwd: string) =>
      jjCore.isJjRepository(cwd).pipe(Effect.catch(() => Effect.succeed(false)));

    const route = <A>(
      cwd: string,
      onJj: Effect.Effect<A, GitCommandError>,
      onGit: Effect.Effect<A, GitCommandError>,
    ) => Effect.flatMap(useJj(cwd), (isJj) => (isJj ? onJj : onGit));

    return {
      status: (input) => route(input.cwd, jjCore.status(input), gitCore.status(input)),
      statusDetails: (cwd) => route(cwd, jjCore.statusDetails(cwd), gitCore.statusDetails(cwd)),
      statusDetailsLocal: (cwd) =>
        route(cwd, jjCore.statusDetailsLocal(cwd), gitCore.statusDetailsLocal(cwd)),
      prepareCommitContext: (cwd, filePaths) =>
        route(
          cwd,
          jjCore.prepareCommitContext(cwd, filePaths),
          gitCore.prepareCommitContext(cwd, filePaths),
        ),
      commit: (cwd, subject, body, options, filePaths) =>
        route(
          cwd,
          jjCore.commit(cwd, subject, body, options, filePaths),
          gitCore.commit(cwd, subject, body, options),
        ),
      pushCurrentBranch: (cwd, fallbackBranch) =>
        route(
          cwd,
          jjCore.pushCurrentBranch(cwd, fallbackBranch),
          gitCore.pushCurrentBranch(cwd, fallbackBranch),
        ),
      pullCurrentBranch: (cwd) =>
        route(cwd, jjCore.pullCurrentBranch(cwd), gitCore.pullCurrentBranch(cwd)),
      readRangeContext: (cwd, baseBranch) =>
        route(
          cwd,
          jjCore.readRangeContext(cwd, baseBranch),
          gitCore.readRangeContext(cwd, baseBranch),
        ),
      listBranches: (input) =>
        route(input.cwd, jjCore.listBranches(input), gitCore.listBranches(input)),
      commitGraph: (input) =>
        Effect.flatMap(useJj(input.cwd), (isJj) => {
          if (isJj) return jjCore.commitGraph(input);
          return gitCore.status(input).pipe(
            Effect.map((status) => ({
              isRepo: status.isRepo,
              ...(status.isRepo ? { vcs: "git" as const } : {}),
              supported: false,
              revset: input.revset?.trim() || "",
              limit: input.limit ?? 150,
              hasMore: false,
              currentOperationId: null,
              nodes: [],
              edges: [],
            })),
          );
        }),
      commitGraphChangeDetails: (input) =>
        route(
          input.cwd,
          jjCore.commitGraphChangeDetails(input),
          Effect.fail(
            new GitCommandError({
              operation: "RepositoryVcs.commitGraphChangeDetails",
              command: "git.commitGraphChangeDetails",
              cwd: input.cwd,
              detail: "Commit graph details are only available for JJ repositories.",
            }),
          ),
        ),
      runCommitGraphAction: (input) =>
        route(
          input.cwd,
          jjCore.runCommitGraphAction(input),
          Effect.fail(
            new GitCommandError({
              operation: "RepositoryVcs.runCommitGraphAction",
              command: "git.runCommitGraphAction",
              cwd: input.cwd,
              detail: "Commit graph actions are only available for JJ repositories.",
            }),
          ),
        ),
      createWorktree: (input) =>
        route(input.cwd, jjCore.createWorktree(input), gitCore.createWorktree(input)),
      removeWorktree: (input) =>
        route(input.cwd, jjCore.removeWorktree(input), gitCore.removeWorktree(input)),
      createBranch: (input) =>
        route(input.cwd, jjCore.createBranch(input), gitCore.createBranch(input)),
      checkoutBranch: (input) =>
        route(input.cwd, jjCore.checkoutBranch(input), gitCore.checkoutBranch(input)),
      initRepo: (input) => jjCore.initRepo(input).pipe(Effect.catch(() => gitCore.initRepo(input))),
      listLocalBranchNames: (cwd) =>
        route(cwd, jjCore.listLocalBranchNames(cwd), gitCore.listLocalBranchNames(cwd)),
    } satisfies RepositoryVcsShape;
  }),
);
