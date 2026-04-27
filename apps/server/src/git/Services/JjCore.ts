import { Context } from "effect";
import type { Effect } from "effect";
import type {
  GitCheckoutInput,
  GitCheckoutResult,
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
