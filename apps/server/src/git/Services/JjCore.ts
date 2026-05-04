import { Context } from "effect";
import type { Effect } from "effect";
import type {
  GitCheckoutInput,
  GitCheckoutResult,
  GitChangeDiffInput,
  GitChangeDiffResult,
  GitCommitGraphActionInput,
  GitCommitGraphActionResult,
  GitCommitGraphChangeDetailsInput,
  GitCommitGraphChangeDetailsResult,
  GitCommitGraphInput,
  GitCommitGraphResult,
  GitCommandError,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitStatusInput,
  GitStatusResult,
  GitThreadChangeSummaryInput,
  GitThreadChangeSummaryResult,
} from "@t3tools/contracts";

import type {
  GitCommitOptions,
  GitPushResult,
  GitPreparedCommitContext,
  GitRangeContext,
  GitStatusDetails,
} from "./GitCore.ts";

export interface JjCoreShape {
  readonly isJjRepository: (cwd: string) => Effect.Effect<boolean, GitCommandError>;
  readonly root: (cwd: string) => Effect.Effect<string, GitCommandError>;
  readonly readCurrentOperationId: (cwd: string) => Effect.Effect<string, GitCommandError>;
  readonly readChange: (
    cwd: string,
    rev: string,
  ) => Effect.Effect<
    {
      readonly changeId: string;
      readonly commitId: string;
      readonly description: string;
      readonly empty: boolean;
    },
    GitCommandError
  >;
  readonly listOperationTouchedChanges: (
    cwd: string,
    fromOperationId: string,
    toOperationId: string,
  ) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
  readonly ensureFallbackTurnChange: (
    cwd: string,
    message: string,
  ) => Effect.Effect<{ readonly changeId: string; readonly commitId: string }, GitCommandError>;
  readonly describeChangeIfEmpty: (
    cwd: string,
    changeId: string,
    message: string,
  ) => Effect.Effect<void, GitCommandError>;
  readonly changeDiff: (
    input: GitChangeDiffInput,
  ) => Effect.Effect<GitChangeDiffResult, GitCommandError>;
  readonly pruneEmptyUndescribedChanges: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
  readonly status: (input: GitStatusInput) => Effect.Effect<GitStatusResult, GitCommandError>;
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    options?: GitCommitOptions,
    filePaths?: readonly string[],
  ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
  readonly pushCurrentBranch: (
    cwd: string,
    fallbackBranch: string | null,
  ) => Effect.Effect<GitPushResult, GitCommandError>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<GitPullResult, GitCommandError>;
  readonly readRangeContext: (
    cwd: string,
    baseBranch: string,
  ) => Effect.Effect<GitRangeContext, GitCommandError>;
  readonly listBranches: (
    input: GitListBranchesInput,
  ) => Effect.Effect<GitListBranchesResult, GitCommandError>;
  readonly commitGraph: (
    input: GitCommitGraphInput,
  ) => Effect.Effect<GitCommitGraphResult, GitCommandError>;
  readonly commitGraphChangeDetails: (
    input: GitCommitGraphChangeDetailsInput,
  ) => Effect.Effect<GitCommitGraphChangeDetailsResult, GitCommandError>;
  readonly runCommitGraphAction: (
    input: GitCommitGraphActionInput,
  ) => Effect.Effect<GitCommitGraphActionResult, GitCommandError>;
  readonly threadChanges: (
    input: GitThreadChangeSummaryInput,
  ) => Effect.Effect<GitThreadChangeSummaryResult, GitCommandError>;
  readonly createWorktree: (
    input: GitCreateWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, GitCommandError>;
  readonly removeWorktree: (input: GitRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly createBranch: (
    input: GitCreateBranchInput,
  ) => Effect.Effect<GitCreateBranchResult, GitCommandError>;
  readonly checkoutBranch: (
    input: GitCheckoutInput,
  ) => Effect.Effect<GitCheckoutResult, GitCommandError>;
  readonly initRepo: (input: GitInitInput) => Effect.Effect<void, GitCommandError>;
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
}

export class JjCore extends Context.Service<JjCore, JjCoreShape>()("t3/git/Services/JjCore") {}
