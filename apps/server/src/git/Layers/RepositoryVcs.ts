import { Effect, Layer } from "effect";
import {
  GitCommandError,
  type GitChangeTurnLink,
  type GitCommitGraphNode,
} from "@t3tools/contracts";

import { GitCore } from "../Services/GitCore.ts";
import { JjCore } from "../Services/JjCore.ts";
import { RepositoryVcs, type RepositoryVcsShape } from "../Services/RepositoryVcs.ts";
import {
  VcsExternalDiffRepository,
  VcsTurnChangeRepository,
  type VcsExternalTurnDiff,
  type VcsTurnChangeLink,
} from "../../persistence/Services/VcsTurnChanges.ts";

const toApiLink = (link: VcsTurnChangeLink): GitChangeTurnLink => ({
  changeId: link.changeId,
  threadId: link.threadId,
  turnId: link.turnId,
  role: link.role,
  firstOperationId: link.firstOperationId,
  lastOperationId: link.lastOperationId,
  firstCommitId: link.firstCommitId,
  latestCommitId: link.latestCommitId,
  createdAt: link.createdAt,
  updatedAt: link.updatedAt,
  prunedAt: link.prunedAt,
});

const toExternalChange = (diff: VcsExternalTurnDiff) => ({
  threadId: diff.threadId,
  turnId: diff.turnId,
  scope: diff.scope,
  cwd: diff.cwd,
  files: diff.files,
  diff: diff.diff,
});

export const RepositoryVcsLive = Layer.effect(
  RepositoryVcs,
  Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const jjCore = yield* JjCore;
    const turnChangeRepository = yield* VcsTurnChangeRepository;
    const externalDiffRepository = yield* VcsExternalDiffRepository;

    const toRepositoryError = (operation: string, cwd: string) => (cause: unknown) =>
      new GitCommandError({
        operation,
        command: "sqlite vcs turn metadata",
        cwd,
        detail: cause instanceof Error ? cause.message : "Failed to read VCS turn metadata.",
        cause,
      });

    const useJj = (cwd: string) =>
      jjCore.isJjRepository(cwd).pipe(Effect.catch(() => Effect.succeed(false)));

    const route = <A>(
      cwd: string,
      onJj: Effect.Effect<A, GitCommandError>,
      onGit: Effect.Effect<A, GitCommandError>,
    ) => Effect.flatMap(useJj(cwd), (isJj) => (isJj ? onJj : onGit));

    const loadLinksForChanges = (cwd: string, repoRoot: string, changeIds: readonly string[]) =>
      turnChangeRepository.listLinksByChangeIds({ repoRoot, changeIds }).pipe(
        Effect.map((links) => links.map(toApiLink)),
        Effect.catch(() => Effect.succeed([])),
      );

    const attachLinksToNodes = (
      links: readonly GitChangeTurnLink[],
      nodes: readonly GitCommitGraphNode[],
    ) => {
      const linksByChangeId = new Map<string, GitChangeTurnLink[]>();
      for (const link of links) {
        const existing = linksByChangeId.get(link.changeId) ?? [];
        existing.push(link);
        linksByChangeId.set(link.changeId, existing);
      }
      return nodes.map((node) => ({
        ...node,
        t3Links: linksByChangeId.get(node.changeId) ?? [],
      }));
    };

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
          if (isJj) {
            return Effect.gen(function* () {
              const graph = yield* jjCore.commitGraph(input);
              const repoRoot = yield* jjCore.root(input.cwd);
              const links = yield* loadLinksForChanges(
                input.cwd,
                repoRoot,
                graph.nodes.map((node) => node.changeId),
              );
              return {
                ...graph,
                nodes: attachLinksToNodes(links, graph.nodes),
              };
            });
          }
          return gitCore.status(input).pipe(
            Effect.map((status) => ({
              isRepo: status.isRepo,
              ...(status.isRepo ? { vcs: "git" as const } : {}),
              supported: false,
              revset: input.revset?.trim() || "unsupported",
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
          Effect.gen(function* () {
            const details = yield* jjCore.commitGraphChangeDetails(input);
            const repoRoot = yield* jjCore.root(input.cwd);
            const links = yield* loadLinksForChanges(input.cwd, repoRoot, [details.node.changeId]);
            return {
              ...details,
              node: {
                ...details.node,
                t3Links: links,
              },
            };
          }),
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
      threadChanges: (input) =>
        Effect.gen(function* () {
          const isJj = yield* useJj(input.cwd);
          const externalChanges = yield* externalDiffRepository
            .listByThread({ threadId: input.threadId, turnId: input.turnId })
            .pipe(
              Effect.map((diffs) => diffs.map(toExternalChange)),
              Effect.mapError(toRepositoryError("RepositoryVcs.threadChanges.external", input.cwd)),
            );
          if (!isJj) {
            const status = yield* gitCore.status({ cwd: input.cwd }).pipe(
              Effect.catch(() =>
                Effect.succeed({
                  isRepo: false,
                  hasOriginRemote: false,
                  isDefaultBranch: false,
                  branch: null,
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: false,
                  upstreamRef: null,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              ),
            );
            return {
              isRepo: status.isRepo,
              ...(status.isRepo ? { vcs: "git" as const } : {}),
              supported: false,
              turns: [],
              externalChanges,
            };
          }
          const repoRoot = yield* jjCore.root(input.cwd);
          const [scopes, links] = yield* Effect.all([
            turnChangeRepository.listScopesByThread({ threadId: input.threadId }).pipe(
              Effect.map((rows) =>
                rows.filter(
                  (scope) =>
                    scope.repoRoot === repoRoot &&
                    (input.turnId === undefined || scope.turnId === input.turnId),
                ),
              ),
              Effect.mapError(toRepositoryError("RepositoryVcs.threadChanges.scopes", input.cwd)),
            ),
            turnChangeRepository
              .listLinksByThread({ threadId: input.threadId, turnId: input.turnId })
              .pipe(
                Effect.map((rows) => rows.filter((link) => link.repoRoot === repoRoot)),
                Effect.map((rows) => rows.map(toApiLink)),
                Effect.mapError(toRepositoryError("RepositoryVcs.threadChanges.links", input.cwd)),
              ),
          ]);
          const linksByTurnId = new Map<string, GitChangeTurnLink[]>();
          for (const link of links) {
            const existing = linksByTurnId.get(link.turnId) ?? [];
            existing.push(link);
            linksByTurnId.set(link.turnId, existing);
          }
          const externalByTurnId = new Map<string, typeof externalChanges>();
          for (const external of externalChanges) {
            const existing = externalByTurnId.get(external.turnId) ?? [];
            existing.push(external);
            externalByTurnId.set(external.turnId, existing);
          }
          const turnIds = new Set([
            ...scopes.map((scope) => scope.turnId),
            ...links.map((link) => link.turnId),
            ...externalChanges.map((external) => external.turnId),
          ]);
          return {
            isRepo: true,
            vcs: "jj" as const,
            supported: true,
            turns: [...turnIds].map((turnId) => ({
              threadId: input.threadId,
              turnId,
              links: linksByTurnId.get(turnId) ?? [],
              externalChanges: externalByTurnId.get(turnId) ?? [],
            })),
            externalChanges,
          };
        }),
      changeDiff: (input) =>
        route(
          input.cwd,
          jjCore.changeDiff(input),
          Effect.fail(
            new GitCommandError({
              operation: "RepositoryVcs.changeDiff",
              command: "git.changeDiff",
              cwd: input.cwd,
              detail: "Change diffs are only available for JJ repositories.",
            }),
          ),
        ),
      listLocalBranchNames: (cwd) =>
        route(cwd, jjCore.listLocalBranchNames(cwd), gitCore.listLocalBranchNames(cwd)),
    } satisfies RepositoryVcsShape;
  }),
);
