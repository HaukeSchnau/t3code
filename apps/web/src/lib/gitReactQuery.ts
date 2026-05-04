import {
  type EnvironmentId,
  type GitCommitGraphActionInput,
  type GitActionProgressEvent,
  type GitStackedAction,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ensureEnvironmentApi } from "../environmentApi";
import { requireEnvironmentConnection } from "../environments/runtime";

const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_PAGE_SIZE = 100;
const GIT_COMMIT_GRAPH_STALE_TIME_MS = 5_000;
const GIT_COMMIT_GRAPH_REFETCH_INTERVAL_MS = 10_000;
export const GIT_COMMIT_GRAPH_DEFAULT_LIMIT = 150;

export const gitQueryKeys = {
  all: ["git"] as const,
  branches: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "branches", environmentId ?? null, cwd] as const,
  branchSearch: (environmentId: EnvironmentId | null, cwd: string | null, query: string) =>
    ["git", "branches", environmentId ?? null, cwd, "search", query] as const,
  commitGraph: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    revset: string | null,
    limit: number,
    threadId?: ThreadId | null,
    turnId?: TurnId | null,
    changeIds?: readonly string[] | null,
  ) =>
    [
      "git",
      "commit-graph",
      environmentId ?? null,
      cwd,
      revset ?? null,
      limit,
      threadId ?? null,
      turnId ?? null,
      changeIds?.join("\n") ?? null,
    ] as const,
  commitGraphDetails: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    changeId: string | null,
  ) => ["git", "commit-graph-details", environmentId ?? null, cwd, changeId] as const,
  threadChanges: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    threadId: ThreadId | null,
    turnId?: TurnId | null,
  ) => ["git", "thread-changes", environmentId ?? null, cwd, threadId, turnId ?? null] as const,
  changeDiff: (environmentId: EnvironmentId | null, cwd: string | null, changeId: string | null) =>
    ["git", "change-diff", environmentId ?? null, cwd, changeId] as const,
};

export const gitMutationKeys = {
  init: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "init", environmentId ?? null, cwd] as const,
  checkout: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "checkout", environmentId ?? null, cwd] as const,
  runStackedAction: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "run-stacked-action", environmentId ?? null, cwd] as const,
  pull: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "pull", environmentId ?? null, cwd] as const,
  preparePullRequestThread: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", environmentId ?? null, cwd] as const,
  runCommitGraphAction: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "commit-graph-action", environmentId ?? null, cwd] as const,
};

export function invalidateGitQueries(
  queryClient: QueryClient,
  input?: { environmentId?: EnvironmentId | null; cwd?: string | null },
) {
  const environmentId = input?.environmentId ?? null;
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(environmentId, cwd) }),
      queryClient.invalidateQueries({
        queryKey: ["git", "commit-graph", environmentId, cwd] as const,
      }),
      queryClient.invalidateQueries({
        queryKey: ["git", "commit-graph-details", environmentId, cwd] as const,
      }),
      queryClient.invalidateQueries({
        queryKey: ["git", "thread-changes", environmentId, cwd] as const,
      }),
      queryClient.invalidateQueries({
        queryKey: ["git", "change-diff", environmentId, cwd] as const,
      }),
    ]);
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function gitCommitGraphQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  revset?: string | null;
  limit?: number;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
  changeIds?: readonly string[] | null;
  enabled?: boolean;
}) {
  const limit = input.limit ?? GIT_COMMIT_GRAPH_DEFAULT_LIMIT;
  const normalizedRevset = input.revset?.trim() || null;
  return queryOptions({
    queryKey: gitQueryKeys.commitGraph(
      input.environmentId,
      input.cwd,
      normalizedRevset,
      limit,
      input.threadId,
      input.turnId,
      input.changeIds,
    ),
    queryFn: async () => {
      if (!input.cwd) throw new Error("JJ graph is unavailable.");
      if (!input.environmentId) throw new Error("JJ graph is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.commitGraph({
        cwd: input.cwd,
        ...(normalizedRevset ? { revset: normalizedRevset } : {}),
        limit,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.changeIds && input.changeIds.length > 0
          ? { changeIds: [...input.changeIds] }
          : {}),
      });
    },
    enabled: input.environmentId !== null && input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_COMMIT_GRAPH_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_COMMIT_GRAPH_REFETCH_INTERVAL_MS,
  });
}

export function gitThreadChangesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  threadId: ThreadId | null;
  turnId?: TurnId | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.threadChanges(
      input.environmentId,
      input.cwd,
      input.threadId,
      input.turnId,
    ),
    queryFn: async () => {
      if (!input.cwd || !input.threadId || !input.environmentId) {
        throw new Error("JJ turn changes are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.threadChanges({
        cwd: input.cwd,
        threadId: input.threadId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      });
    },
    enabled:
      input.environmentId !== null &&
      input.cwd !== null &&
      input.threadId !== null &&
      (input.enabled ?? true),
    staleTime: GIT_COMMIT_GRAPH_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_COMMIT_GRAPH_REFETCH_INTERVAL_MS,
  });
}

export function gitChangeDiffQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  changeId: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.changeDiff(input.environmentId, input.cwd, input.changeId),
    queryFn: async () => {
      if (!input.cwd || !input.changeId || !input.environmentId) {
        throw new Error("JJ change diff is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.changeDiff({ cwd: input.cwd, changeId: input.changeId });
    },
    enabled:
      input.environmentId !== null &&
      input.cwd !== null &&
      input.changeId !== null &&
      (input.enabled ?? true),
    staleTime: GIT_COMMIT_GRAPH_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function gitCommitGraphDetailsQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  changeId: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.commitGraphDetails(input.environmentId, input.cwd, input.changeId),
    queryFn: async () => {
      if (!input.cwd || !input.changeId || !input.environmentId) {
        throw new Error("JJ graph details are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.commitGraphChangeDetails({ cwd: input.cwd, changeId: input.changeId });
    },
    enabled:
      input.environmentId !== null &&
      input.cwd !== null &&
      input.changeId !== null &&
      (input.enabled ?? true),
    staleTime: GIT_COMMIT_GRAPH_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function gitCommitGraphActionMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runCommitGraphAction(input.environmentId, input.cwd),
    mutationFn: async (actionInput: Omit<GitCommitGraphActionInput, "cwd">) => {
      if (!input.cwd || !input.environmentId) throw new Error("JJ graph action is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.runCommitGraphAction({ ...actionInput, cwd: input.cwd });
    },
    onSuccess: () => {
      void invalidateGitQueries(input.queryClient, {
        environmentId: input.environmentId,
        cwd: input.cwd,
      });
    },
  });
}

function invalidateGitBranchQueries(
  queryClient: QueryClient,
  environmentId: EnvironmentId | null,
  cwd: string | null,
) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(environmentId, cwd) });
}

export function gitBranchSearchInfiniteQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
}) {
  const normalizedQuery = input.query.trim();

  return infiniteQueryOptions({
    queryKey: gitQueryKeys.branchSearch(input.environmentId, input.cwd, normalizedQuery),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      if (!input.cwd) throw new Error("VCS branches are unavailable.");
      if (!input.environmentId) throw new Error("VCS branches are unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.listBranches({
        cwd: input.cwd,
        ...(normalizedQuery.length > 0 ? { query: normalizedQuery } : {}),
        cursor: pageParam,
        limit: GIT_BRANCHES_PAGE_SIZE,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: [
      "git",
      "pull-request",
      input.environmentId ?? null,
      input.cwd,
      input.reference,
    ] as const,
    queryFn: async () => {
      if (!input.cwd || !input.reference || !input.environmentId) {
        throw new Error("Pull request lookup is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.environmentId !== null && input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitInitMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.environmentId, input.cwd),
    mutationFn: async () => {
      if (!input.cwd || !input.environmentId) throw new Error("Git init is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.init({ cwd: input.cwd });
    },
    onSettled: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.environmentId, input.cwd),
    mutationFn: async (branch: string) => {
      if (!input.cwd || !input.environmentId) throw new Error("Git checkout is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.checkout({ cwd: input.cwd, branch });
    },
    onSettled: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.environmentId, input.cwd),
    mutationFn: async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      onProgress,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (!input.cwd || !input.environmentId) throw new Error("Git action is unavailable.");
      return requireEnvironmentConnection(input.environmentId).client.git.runStackedAction(
        {
          action,
          actionId,
          cwd: input.cwd,
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch: true } : {}),
          ...(filePaths && filePaths.length > 0 ? { filePaths } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitPullMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.environmentId, input.cwd),
    mutationFn: async () => {
      if (!input.cwd || !input.environmentId) throw new Error("Git pull is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.pull({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: {
  environmentId: EnvironmentId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "create-worktree", input.environmentId ?? null] as const,
    mutationFn: (
      args: Parameters<ReturnType<typeof ensureEnvironmentApi>["git"]["createWorktree"]>[0],
    ) => {
      if (!input.environmentId) {
        throw new Error("Worktree creation is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).git.createWorktree(args);
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, { environmentId: input.environmentId });
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: {
  environmentId: EnvironmentId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "remove-worktree", input.environmentId ?? null] as const,
    mutationFn: (
      args: Parameters<ReturnType<typeof ensureEnvironmentApi>["git"]["removeWorktree"]>[0],
    ) => {
      if (!input.environmentId) {
        throw new Error("Worktree removal is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).git.removeWorktree(args);
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, { environmentId: input.environmentId });
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.preparePullRequestThread(input.environmentId, input.cwd),
    mutationFn: async (args: {
      reference: string;
      mode: "local" | "worktree";
      threadId?: ThreadId;
    }) => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Pull request thread preparation is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        reference: args.reference,
        mode: args.mode,
        ...(args.threadId ? { threadId: args.threadId } : {}),
      });
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}
