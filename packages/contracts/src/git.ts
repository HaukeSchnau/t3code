import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;
const GIT_COMMIT_GRAPH_MAX_LIMIT = 500;

// Domain Types

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const GitStatusPrState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
export const VcsKind = Schema.Literals(["git", "jj"]);
export type VcsKind = typeof VcsKind.Type;
export const GitHostingProviderKind = Schema.Literals(["github", "gitlab", "unknown"]);
export type GitHostingProviderKind = typeof GitHostingProviderKind.Type;
export const GitHostingProvider = Schema.Struct({
  kind: GitHostingProviderKind,
  name: TrimmedNonEmptyStringSchema,
  baseUrl: Schema.String,
});
export type GitHostingProvider = typeof GitHostingProvider.Type;
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const GitBranch = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitBranch = typeof GitBranch.Type;

const GitWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

// RPC Inputs

export const GitStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitStatusInput = typeof GitStatusInput.Type;

export const GitPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitPullInput = typeof GitPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const GitListBranchesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type GitListBranchesInput = typeof GitListBranchesInput.Type;

export const GitCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
  newBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitCreateWorktreeInput = typeof GitCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const GitRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type GitRemoveWorktreeInput = typeof GitRemoveWorktreeInput.Type;

export const GitCreateBranchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
  checkout: Schema.optional(Schema.Boolean),
});
export type GitCreateBranchInput = typeof GitCreateBranchInput.Type;

export const GitCreateBranchResult = Schema.Struct({
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCreateBranchResult = typeof GitCreateBranchResult.Type;

export const GitCheckoutInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCheckoutInput = typeof GitCheckoutInput.Type;

export const GitInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitInitInput = typeof GitInitInput.Type;

export const GitCommitGraphInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  revset: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(2_000))),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_COMMIT_GRAPH_MAX_LIMIT))),
  threadId: Schema.optional(ThreadId),
  turnId: Schema.optional(TurnId),
  changeIds: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
});
export type GitCommitGraphInput = typeof GitCommitGraphInput.Type;

export const GitCommitGraphChangeDetailsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  changeId: TrimmedNonEmptyStringSchema,
});
export type GitCommitGraphChangeDetailsInput = typeof GitCommitGraphChangeDetailsInput.Type;

const GitCommitGraphActionChangeId = TrimmedNonEmptyStringSchema;
const GitCommitGraphActionBookmark = TrimmedNonEmptyStringSchema;
const GitCommitGraphActionFilesets = Schema.Array(TrimmedNonEmptyStringSchema).check(
  Schema.isMinLength(1),
);
const GitChangeTurnLinkRole = Schema.Literals([
  "guard",
  "created",
  "modified",
  "fallback",
  "finalized",
]);
export type GitChangeTurnLinkRole = typeof GitChangeTurnLinkRole.Type;
const GitExternalTurnChangeScope = Schema.Literals(["non_repo", "outside_repo", "unsupported"]);
export type GitExternalTurnChangeScope = typeof GitExternalTurnChangeScope.Type;
const GitCommitGraphRebaseMode = Schema.Literals(["source", "branch", "revisions"]);
const GitCommitGraphDestinationMode = Schema.Literals(["onto", "after", "before"]);

const GitCommitGraphAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("edit"),
    changeId: GitCommitGraphActionChangeId,
  }),
  Schema.Struct({
    kind: Schema.Literal("describe"),
    changeId: GitCommitGraphActionChangeId,
    message: Schema.String.check(Schema.isMaxLength(20_000)),
  }),
  Schema.Struct({
    kind: Schema.Literal("new"),
    parentChangeIds: Schema.Array(GitCommitGraphActionChangeId).check(Schema.isMinLength(1)),
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
    edit: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("insert_new"),
    changeId: GitCommitGraphActionChangeId,
    position: Schema.Literals(["after", "before"]),
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
  }),
  Schema.Struct({
    kind: Schema.Literal("abandon"),
    changeIds: Schema.Array(GitCommitGraphActionChangeId).check(Schema.isMinLength(1)),
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("duplicate"),
    changeIds: Schema.Array(GitCommitGraphActionChangeId).check(Schema.isMinLength(1)),
    destinationMode: Schema.optional(GitCommitGraphDestinationMode),
    destinationChangeIds: Schema.optional(
      Schema.Array(GitCommitGraphActionChangeId).check(Schema.isMinLength(1)),
    ),
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("rebase"),
    mode: GitCommitGraphRebaseMode,
    revset: TrimmedNonEmptyStringSchema,
    destinationMode: GitCommitGraphDestinationMode,
    destinationChangeIds: Schema.Array(GitCommitGraphActionChangeId).check(Schema.isMinLength(1)),
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("squash"),
    fromChangeId: GitCommitGraphActionChangeId,
    intoChangeId: GitCommitGraphActionChangeId,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("split"),
    changeId: GitCommitGraphActionChangeId,
    filesets: GitCommitGraphActionFilesets,
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("bookmark_set"),
    name: GitCommitGraphActionBookmark,
    changeId: GitCommitGraphActionChangeId,
  }),
  Schema.Struct({
    kind: Schema.Literal("bookmark_move"),
    name: GitCommitGraphActionBookmark,
    changeId: GitCommitGraphActionChangeId,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("bookmark_rename"),
    oldName: GitCommitGraphActionBookmark,
    newName: GitCommitGraphActionBookmark,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("bookmark_delete"),
    name: GitCommitGraphActionBookmark,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("bookmark_track"),
    name: GitCommitGraphActionBookmark,
    remote: GitCommitGraphActionBookmark,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("bookmark_untrack"),
    name: GitCommitGraphActionBookmark,
    remote: GitCommitGraphActionBookmark,
    confirmed: Schema.Boolean,
  }),
]);
export type GitCommitGraphAction = typeof GitCommitGraphAction.Type;

export const GitCommitGraphActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  expectedOperationId: TrimmedNonEmptyStringSchema,
  action: GitCommitGraphAction,
});
export type GitCommitGraphActionInput = typeof GitCommitGraphActionInput.Type;

export const GitThreadChangeSummaryInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type GitThreadChangeSummaryInput = typeof GitThreadChangeSummaryInput.Type;

export const GitChangeDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  changeId: TrimmedNonEmptyStringSchema,
});
export type GitChangeDiffInput = typeof GitChangeDiffInput.Type;

// RPC Results

const GitStatusPr = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitStatusPrState,
});

const GitStatusLocalShape = {
  isRepo: Schema.Boolean,
  vcs: Schema.optional(VcsKind),
  hostingProvider: Schema.optional(GitHostingProvider),
  hasOriginRemote: Schema.Boolean,
  isDefaultBranch: Schema.Boolean,
  branch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyStringSchema,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
};

const GitStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  pr: Schema.NullOr(GitStatusPr),
};

export const GitStatusLocalResult = Schema.Struct(GitStatusLocalShape);
export type GitStatusLocalResult = typeof GitStatusLocalResult.Type;

export const GitStatusRemoteResult = Schema.Struct(GitStatusRemoteShape);
export type GitStatusRemoteResult = typeof GitStatusRemoteResult.Type;

export const GitStatusResult = Schema.Struct({
  ...GitStatusLocalShape,
  ...GitStatusRemoteShape,
});
export type GitStatusResult = typeof GitStatusResult.Type;

export const GitStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: GitStatusLocalResult,
    remote: Schema.NullOr(GitStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: GitStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(GitStatusRemoteResult),
  }),
]);
export type GitStatusStreamEvent = typeof GitStatusStreamEvent.Type;

export const GitListBranchesResult = Schema.Struct({
  branches: Schema.Array(GitBranch),
  isRepo: Schema.Boolean,
  vcs: Schema.optional(VcsKind),
  hasOriginRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type GitListBranchesResult = typeof GitListBranchesResult.Type;

export const GitCreateWorktreeResult = Schema.Struct({
  worktree: GitWorktree,
});
export type GitCreateWorktreeResult = typeof GitCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const GitCheckoutResult = Schema.Struct({
  branch: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitCheckoutResult = typeof GitCheckoutResult.Type;

export const GitChangeTurnLink = Schema.Struct({
  changeId: TrimmedNonEmptyStringSchema,
  threadId: ThreadId,
  turnId: TurnId,
  role: GitChangeTurnLinkRole,
  firstOperationId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  lastOperationId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  firstCommitId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  latestCommitId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  prunedAt: Schema.NullOr(IsoDateTime),
});
export type GitChangeTurnLink = typeof GitChangeTurnLink.Type;

const GitChangeFile = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type GitChangeFile = typeof GitChangeFile.Type;

export const GitExternalTurnChange = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  scope: GitExternalTurnChangeScope,
  cwd: TrimmedNonEmptyStringSchema,
  files: Schema.Array(GitChangeFile),
  diff: Schema.String,
});
export type GitExternalTurnChange = typeof GitExternalTurnChange.Type;

export const GitThreadChangeTurn = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  links: Schema.Array(GitChangeTurnLink),
  externalChanges: Schema.Array(GitExternalTurnChange),
});
export type GitThreadChangeTurn = typeof GitThreadChangeTurn.Type;

export const GitThreadChangeSummaryResult = Schema.Struct({
  isRepo: Schema.Boolean,
  vcs: Schema.optional(VcsKind),
  supported: Schema.Boolean,
  turns: Schema.Array(GitThreadChangeTurn),
  externalChanges: Schema.Array(GitExternalTurnChange),
});
export type GitThreadChangeSummaryResult = typeof GitThreadChangeSummaryResult.Type;

export const GitChangeDiffResult = Schema.Struct({
  changeId: TrimmedNonEmptyStringSchema,
  commitId: TrimmedNonEmptyStringSchema,
  files: Schema.Array(GitChangeFile),
  diff: Schema.String,
  tooLarge: Schema.Boolean,
});
export type GitChangeDiffResult = typeof GitChangeDiffResult.Type;

export const GitCommitGraphNode = Schema.Struct({
  changeId: TrimmedNonEmptyStringSchema,
  displayChangeId: TrimmedNonEmptyStringSchema,
  commitId: TrimmedNonEmptyStringSchema,
  shortCommitId: TrimmedNonEmptyStringSchema,
  parentChangeIds: Schema.Array(TrimmedNonEmptyStringSchema),
  description: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  committerTimestamp: Schema.String,
  localBookmarks: Schema.Array(TrimmedNonEmptyStringSchema),
  remoteBookmarks: Schema.Array(TrimmedNonEmptyStringSchema),
  currentWorkingCopy: Schema.Boolean,
  empty: Schema.Boolean,
  conflict: Schema.Boolean,
  immutable: Schema.Boolean,
  divergent: Schema.Boolean,
  wip: Schema.Boolean,
  t3Links: Schema.Array(GitChangeTurnLink),
});
export type GitCommitGraphNode = typeof GitCommitGraphNode.Type;

export const GitCommitGraphEdge = Schema.Struct({
  fromChangeId: TrimmedNonEmptyStringSchema,
  toChangeId: TrimmedNonEmptyStringSchema,
  elidedParent: Schema.Boolean,
});
export type GitCommitGraphEdge = typeof GitCommitGraphEdge.Type;

export const GitCommitGraphResult = Schema.Struct({
  isRepo: Schema.Boolean,
  vcs: Schema.optional(VcsKind),
  supported: Schema.Boolean,
  revset: TrimmedNonEmptyStringSchema,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_COMMIT_GRAPH_MAX_LIMIT)),
  hasMore: Schema.Boolean,
  currentOperationId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  nodes: Schema.Array(GitCommitGraphNode),
  edges: Schema.Array(GitCommitGraphEdge),
});
export type GitCommitGraphResult = typeof GitCommitGraphResult.Type;

export const GitCommitGraphChangeDetailsResult = Schema.Struct({
  node: GitCommitGraphNode,
  changedFilesSummary: Schema.String,
  diffStat: Schema.String,
  diffPreview: Schema.String,
  diffPreviewTruncated: Schema.Boolean,
});
export type GitCommitGraphChangeDetailsResult = typeof GitCommitGraphChangeDetailsResult.Type;

export const GitCommitGraphActionResult = Schema.Struct({
  action: GitCommitGraphAction,
  status: Schema.Literal("applied"),
  operationId: Schema.optional(TrimmedNonEmptyStringSchema),
  targetChangeId: Schema.optional(TrimmedNonEmptyStringSchema),
  branch: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitCommitGraphActionResult = typeof GitCommitGraphActionResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const GitPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  branch: TrimmedNonEmptyStringSchema,
  upstreamBranch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPullResult = typeof GitPullResult.Type;

// RPC / domain errors
export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

export class GitHubCliError extends Schema.TaggedErrorClass<GitHubCliError>()("GitHubCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedErrorClass<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitCommandError,
  GitHubCliError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
