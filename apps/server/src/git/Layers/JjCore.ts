import { basename, join } from "node:path";

import { Effect, FileSystem, Layer, Path } from "effect";
import type {
  GitBranch,
  GitCommitGraphAction,
  GitCommitGraphEdge,
  GitCommitGraphNode,
} from "@t3tools/contracts";
import { GitCommandError } from "@t3tools/contracts";

import { runProcess } from "../../processRunner.ts";
import { ServerConfig } from "../../config.ts";
import { JjCore, type JjCoreShape } from "../Services/JjCore.ts";
import type { GitCommitOptions, GitPushResult, GitStatusDetails } from "../Services/GitCore.ts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const JJ_GLOBAL_ARGS = [
  "--no-pager",
  "--config",
  "revsets.short-prefixes=none()",
  "--config",
  "ui.log-word-wrap=false",
] as const;
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const LIST_BRANCHES_DEFAULT_LIMIT = 100;
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const COMMIT_GRAPH_DEFAULT_LIMIT = 150;
const COMMIT_GRAPH_MAX_LIMIT = 500;
const COMMIT_GRAPH_DIFF_PREVIEW_MAX_OUTPUT_BYTES = 80_000;

interface ExecuteJjOptions {
  readonly allowNonZeroExit?: boolean;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
}

function commandLabel(args: readonly string[]): string {
  return `jj ${args.join(" ")}`;
}

function createJjCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isNotJjRepositoryError(error: GitCommandError): boolean {
  const normalized = `${error.detail}\n${error.message}`.toLowerCase();
  return (
    normalized.includes("no jj repo") ||
    normalized.includes("not in a jj repo") ||
    normalized.includes("there is no jj repo") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("not a directory")
  );
}

function parseSummaryLine(line: string): { path: string; insertions: number; deletions: number } {
  const trimmed = line.trim();
  const status = trimmed.slice(0, 1);
  const path = trimmed.slice(1).trim();
  return {
    path,
    insertions: status === "D" ? 0 : 0,
    deletions: status === "A" ? 0 : 0,
  };
}

function parseStatTotals(stdout: string): { insertions: number; deletions: number } {
  const summaryLine =
    stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find((line) => /files? changed/.test(line)) ?? "";
  const insertions = Number.parseInt(/(\d+)\s+insertions?\(\+\)/.exec(summaryLine)?.[1] ?? "0", 10);
  const deletions = Number.parseInt(/(\d+)\s+deletions?\(-\)/.exec(summaryLine)?.[1] ?? "0", 10);
  return {
    insertions: Number.isFinite(insertions) ? insertions : 0,
    deletions: Number.isFinite(deletions) ? deletions : 0,
  };
}

function splitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseBookmarkList(stdout: string): Array<{
  name: string;
  commitId: string;
  remote: string | null;
}> {
  const entries: Array<{ name: string; commitId: string; remote: string | null }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const [name = "", commitId = "", remote = ""] = line.split("\t");
    const trimmedName = name.trim();
    const trimmedCommitId = commitId.trim();
    const trimmedRemote = remote.trim();
    if (trimmedName.length === 0 || trimmedCommitId.length === 0) {
      continue;
    }
    entries.push({
      name: trimmedName,
      commitId: trimmedCommitId,
      remote: trimmedRemote.length > 0 ? trimmedRemote : null,
    });
  }
  return entries;
}

function parseRemoteBranchName(
  branchName: string,
): { remoteName: string; branchName: string } | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const remoteName = branchName.slice(0, separatorIndex).trim();
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return remoteName.length > 0 && localBranch.length > 0
    ? { remoteName, branchName: localBranch }
    : null;
}

function sanitizeWorkspaceName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "workspace";
}

function paginateBranches(input: {
  branches: ReadonlyArray<GitBranch>;
  query?: string | undefined;
  cursor?: number | undefined;
  limit?: number | undefined;
}) {
  const normalizedQuery = input.query?.trim().toLowerCase() ?? "";
  const filtered =
    normalizedQuery.length === 0
      ? input.branches
      : input.branches.filter((branch) => branch.name.toLowerCase().includes(normalizedQuery));
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? LIST_BRANCHES_DEFAULT_LIMIT;
  const branches = filtered.slice(cursor, cursor + limit);
  return {
    branches,
    totalCount: filtered.length,
    nextCursor: cursor + branches.length < filtered.length ? cursor + branches.length : null,
  };
}

const COMMIT_GRAPH_NODE_TEMPLATE = `
change_id ++ "\t" ++
change_id.short() ++ "\t" ++
commit_id ++ "\t" ++
commit_id.short() ++ "\t" ++
parents.map(|p| p.change_id()).join(" ") ++ "\t" ++
(description.first_line().replace("\\n", " ").replace("\\t", " ")) ++ "\t" ++
(author.name().replace("\\n", " ").replace("\\t", " ")) ++ "\t" ++
author.email() ++ "\t" ++
committer.timestamp().format("%Y-%m-%dT%H:%M:%S%z") ++ "\t" ++
local_bookmarks.map(|b| b.name()).join(" ") ++ "\t" ++
remote_bookmarks.map(|b| b.name()).join(" ") ++ "\t" ++
current_working_copy ++ "\t" ++
empty ++ "\t" ++
conflict ++ "\t" ++
immutable ++ "\t" ++
divergent ++ "\n"
`.trim();

function splitCommitGraphList(value: string): string[] {
  return value
    .split(" ")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function defaultCommitGraphRevset(limit: number): string {
  return `ancestors(visible_heads() | bookmarks() | tracked_remote_bookmarks() | @, ${limit})`;
}

function parseCommitGraphNode(line: string): GitCommitGraphNode {
  const [
    changeId = "",
    displayChangeId = "",
    commitId = "",
    shortCommitId = "",
    parentChangeIds = "",
    description = "",
    authorName = "",
    authorEmail = "",
    committerTimestamp = "",
    localBookmarks = "",
    remoteBookmarks = "",
    currentWorkingCopy = "false",
    empty = "false",
    conflict = "false",
    immutable = "false",
    divergent = "false",
  ] = line.split("\t");
  return {
    changeId,
    displayChangeId,
    commitId,
    shortCommitId,
    parentChangeIds: splitCommitGraphList(parentChangeIds),
    description,
    authorName,
    authorEmail,
    committerTimestamp,
    localBookmarks: splitCommitGraphList(localBookmarks),
    remoteBookmarks: splitCommitGraphList(remoteBookmarks),
    currentWorkingCopy: currentWorkingCopy === "true",
    empty: empty === "true",
    conflict: conflict === "true",
    immutable: immutable === "true",
    divergent: divergent === "true",
  };
}

function deriveCommitGraphEdges(nodes: ReadonlyArray<GitCommitGraphNode>): GitCommitGraphEdge[] {
  const loadedChangeIds = new Set(nodes.map((node) => node.changeId));
  const edges: GitCommitGraphEdge[] = [];
  for (const node of nodes) {
    for (const parentChangeId of node.parentChangeIds) {
      edges.push({
        fromChangeId: node.changeId,
        toChangeId: parentChangeId,
        elidedParent: !loadedChangeIds.has(parentChangeId),
      });
    }
  }
  return edges;
}

function requireConfirmed(
  operation: string,
  cwd: string,
  args: readonly string[],
  action: Extract<GitCommitGraphAction, { confirmed: boolean }>,
): Effect.Effect<void, GitCommandError> {
  if (action.confirmed) return Effect.void;
  return Effect.fail(
    createJjCommandError(
      operation,
      cwd,
      args,
      "This JJ graph action must be confirmed before it can run.",
    ),
  );
}

export const makeJjCore = Effect.fn("makeJjCore")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreesDir } = yield* ServerConfig;

  const executeJj = Effect.fn("JjCore.execute")(function* (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteJjOptions = {},
  ) {
    const commandArgs = [...JJ_GLOBAL_ARGS, ...args];
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("jj", commandArgs, {
          cwd,
          stdin: options.stdin,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          allowNonZeroExit: true,
          maxBufferBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          outputMode: options.truncateOutputAtMaxBytes ? "truncate" : "error",
        }),
      catch: (cause) =>
        createJjCommandError(
          operation,
          cwd,
          args,
          cause instanceof Error ? cause.message : "jj command failed.",
          cause,
        ),
    });
    const exitCode = result.code ?? (result.signal ? 1 : 0);
    if (!options.allowNonZeroExit && exitCode !== 0) {
      const detail = result.stderr.trim() || `${commandLabel(args)} failed with code ${exitCode}.`;
      return yield* createJjCommandError(operation, cwd, args, detail);
    }
    return {
      code: exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated ?? false,
      stderrTruncated: result.stderrTruncated ?? false,
    };
  });

  const runJjStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteJjOptions = {},
  ) => executeJj(operation, cwd, args, options).pipe(Effect.map((result) => result.stdout));

  const runJj = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteJjOptions = {},
  ) => executeJj(operation, cwd, args, options).pipe(Effect.asVoid);

  const resolveCurrentCommitId = (cwd: string, rev = "@") =>
    runJjStdout("JjCore.resolveCurrentCommitId", cwd, [
      "log",
      "--no-graph",
      "-r",
      rev,
      "-T",
      'commit_id ++ "\n"',
    ]).pipe(Effect.map((stdout) => stdout.trim()));

  const resolveCurrentBookmarks = (cwd: string) =>
    runJjStdout("JjCore.resolveCurrentBookmarks", cwd, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'bookmarks.map(|b| b.name()).join("\n") ++ "\n"',
    ]).pipe(Effect.map(splitLines));

  const listRemoteNames = (cwd: string) =>
    runJjStdout("JjCore.listRemoteNames", cwd, ["git", "remote", "list"], {
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((stdout) =>
        splitLines(stdout)
          .map((line) => line.split(/\s+/)[0]?.trim() ?? "")
          .filter((remoteName) => remoteName.length > 0),
      ),
    );

  const listBookmarks = (cwd: string, allRemotes = true) =>
    runJjStdout("JjCore.listBookmarks", cwd, [
      "bookmark",
      "list",
      ...(allRemotes ? ["--all-remotes"] : []),
      "-T",
      'name ++ "\t" ++ normal_target.commit_id() ++ "\t" ++ if(remote, remote, "") ++ "\n"',
    ]).pipe(Effect.map(parseBookmarkList));

  const resolvePrimaryRemoteName = Effect.fn("JjCore.resolvePrimaryRemoteName")(function* (
    cwd: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd);
    if (remoteNames.includes("origin")) return "origin";
    return remoteNames[0] ?? null;
  });

  const resolveDefaultBookmark = Effect.fn("JjCore.resolveDefaultBookmark")(function* (
    cwd: string,
  ) {
    const bookmarks = yield* listBookmarks(cwd).pipe(Effect.catch(() => Effect.succeed([])));
    for (const candidate of DEFAULT_BASE_BRANCH_CANDIDATES) {
      if (bookmarks.some((bookmark) => bookmark.remote === null && bookmark.name === candidate)) {
        return candidate;
      }
    }
    for (const candidate of DEFAULT_BASE_BRANCH_CANDIDATES) {
      if (bookmarks.some((bookmark) => bookmark.remote !== null && bookmark.name === candidate)) {
        return candidate;
      }
    }
    return null;
  });

  const computeAheadBehind = Effect.fn("JjCore.computeAheadBehind")(function* (
    cwd: string,
    branch: string,
    remoteName: string | null,
  ) {
    if (!remoteName) {
      return { hasUpstream: false, upstreamRef: null, aheadCount: 0, behindCount: 0 };
    }
    const bookmarks = yield* listBookmarks(cwd).pipe(Effect.catch(() => Effect.succeed([])));
    if (!bookmarks.some((bookmark) => bookmark.remote === remoteName && bookmark.name === branch)) {
      return { hasUpstream: false, upstreamRef: null, aheadCount: 0, behindCount: 0 };
    }
    const remoteRef = `${branch}@${remoteName}`;
    const countRevset = (revset: string) =>
      runJjStdout("JjCore.computeAheadBehind.count", cwd, [
        "log",
        "--no-graph",
        "-r",
        revset,
        "-T",
        '"x\n"',
      ]).pipe(
        Effect.map((stdout) => splitLines(stdout).length),
        Effect.catch(() => Effect.succeed(0)),
      );
    const [aheadCount, behindCount] = yield* Effect.all(
      [countRevset(`${remoteRef}..${branch}`), countRevset(`${branch}..${remoteRef}`)],
      { concurrency: "unbounded" },
    );
    return {
      hasUpstream: true,
      upstreamRef: `${remoteName}/${branch}`,
      aheadCount,
      behindCount,
    };
  });

  const readStatusDetailsLocal = Effect.fn("JjCore.readStatusDetailsLocal")(function* (
    cwd: string,
  ) {
    const root = yield* runJjStdout("JjCore.statusDetails.root", cwd, ["root"], {
      allowNonZeroExit: true,
    });
    if (root.trim().length === 0) {
      return yield* createJjCommandError("JjCore.statusDetails.root", cwd, ["root"], root);
    }

    const [currentBookmarks, summaryStdout, statStdout, defaultBookmark, remoteNames, remoteName] =
      yield* Effect.all(
        [
          resolveCurrentBookmarks(cwd),
          runJjStdout("JjCore.statusDetails.summary", cwd, ["diff", "--summary", "-r", "@"]),
          runJjStdout("JjCore.statusDetails.stat", cwd, ["diff", "--stat", "-r", "@"]),
          resolveDefaultBookmark(cwd),
          listRemoteNames(cwd).pipe(Effect.catch(() => Effect.succeed<string[]>([]))),
          resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null))),
        ],
        { concurrency: "unbounded" },
      );
    const branch = currentBookmarks[0] ?? null;
    const summaryLines = splitLines(summaryStdout);
    const totals = parseStatTotals(statStdout);
    const upstream = branch
      ? yield* computeAheadBehind(cwd, branch, remoteName)
      : { hasUpstream: false, upstreamRef: null, aheadCount: 0, behindCount: 0 };

    return {
      isRepo: true,
      vcs: "jj" as const,
      hasOriginRemote: remoteNames.includes("origin"),
      isDefaultBranch:
        branch !== null &&
        (branch === defaultBookmark ||
          (defaultBookmark === null && (branch === "main" || branch === "master"))),
      branch,
      upstreamRef: upstream.upstreamRef,
      hasWorkingTreeChanges: summaryLines.length > 0,
      workingTree: {
        files: summaryLines.map(parseSummaryLine).filter((entry) => entry.path.length > 0),
        insertions: totals.insertions,
        deletions: totals.deletions,
      },
      hasUpstream: upstream.hasUpstream,
      aheadCount: upstream.aheadCount,
      behindCount: upstream.behindCount,
    } satisfies GitStatusDetails;
  });

  const isJjRepository: JjCoreShape["isJjRepository"] = (cwd) =>
    executeJj("JjCore.isJjRepository", cwd, ["root"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(Effect.map((result) => result.code === 0 && result.stdout.trim().length > 0));

  const statusDetailsLocal: JjCoreShape["statusDetailsLocal"] = (cwd) =>
    readStatusDetailsLocal(cwd);

  const statusDetails: JjCoreShape["statusDetails"] = (cwd) => readStatusDetailsLocal(cwd);

  const status: JjCoreShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        vcs: "jj" as const,
        hasOriginRemote: details.hasOriginRemote,
        isDefaultBranch: details.isDefaultBranch,
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      })),
    );

  const prepareCommitContext: JjCoreShape["prepareCommitContext"] = (cwd, filePaths) =>
    Effect.gen(function* () {
      const pathArgs = filePaths && filePaths.length > 0 ? ["--", ...filePaths] : [];
      const stagedSummary = yield* runJjStdout("JjCore.prepareCommitContext.summary", cwd, [
        "diff",
        "--summary",
        "-r",
        "@",
        ...pathArgs,
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      if (stagedSummary.length === 0) {
        return null;
      }
      const stagedPatch = yield* runJjStdout(
        "JjCore.prepareCommitContext.patch",
        cwd,
        ["diff", "--git", "-r", "@", ...pathArgs],
        {
          maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
          truncateOutputAtMaxBytes: true,
        },
      );
      return { stagedSummary, stagedPatch };
    });

  const commit: JjCoreShape["commit"] = (
    cwd,
    subject,
    body,
    options?: GitCommitOptions,
    filePaths?,
  ) =>
    Effect.gen(function* () {
      const message = body.trim().length > 0 ? `${subject}\n\n${body.trim()}` : subject;
      const pathArgs = filePaths && filePaths.length > 0 ? ["--", ...filePaths] : [];
      const result = yield* executeJj(
        "JjCore.commit",
        cwd,
        ["commit", "-m", message, ...pathArgs],
        { timeoutMs: options?.timeoutMs ?? 10 * 60_000 },
      );
      const emitLines = (stream: "stdout" | "stderr", text: string) =>
        Effect.forEach(
          splitLines(text),
          (line) => options?.progress?.onOutputLine?.({ stream, text: line }) ?? Effect.void,
        );
      yield* emitLines("stdout", result.stdout);
      yield* emitLines("stderr", result.stderr);
      const commitSha = yield* resolveCurrentCommitId(cwd, "@-");
      return { commitSha };
    });

  const pushCurrentBranch: JjCoreShape["pushCurrentBranch"] = (cwd, fallbackBranch) =>
    Effect.gen(function* () {
      const currentBookmarks = yield* resolveCurrentBookmarks(cwd);
      const branch = currentBookmarks[0] ?? fallbackBranch;
      if (!branch) {
        return yield* createJjCommandError(
          "JjCore.pushCurrentBranch",
          cwd,
          ["git", "push"],
          "Cannot push because the current JJ change has no bookmark.",
        );
      }
      const remoteName = yield* resolvePrimaryRemoteName(cwd);
      if (!remoteName) {
        return yield* createJjCommandError(
          "JjCore.pushCurrentBranch",
          cwd,
          ["git", "push"],
          "Cannot push because no git remote is configured for this JJ repository.",
        );
      }
      const targetRev = currentBookmarks.includes(branch) ? "@" : "@-";
      yield* runJj("JjCore.pushCurrentBranch.bookmark", cwd, [
        "bookmark",
        "set",
        branch,
        "-r",
        targetRev,
        "--allow-backwards",
      ]);
      yield* runJj("JjCore.pushCurrentBranch.push", cwd, [
        "git",
        "push",
        "--remote",
        remoteName,
        "--bookmark",
        branch,
        "--allow-empty-description",
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${remoteName}/${branch}`,
        setUpstream: true,
      } satisfies GitPushResult;
    });

  const pullCurrentBranch: JjCoreShape["pullCurrentBranch"] = (cwd) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createJjCommandError(
          "JjCore.pullCurrentBranch",
          cwd,
          ["git", "fetch"],
          "Cannot sync because the current JJ change has no bookmark.",
        );
      }
      const remoteName = yield* resolvePrimaryRemoteName(cwd);
      if (!remoteName) {
        return yield* createJjCommandError(
          "JjCore.pullCurrentBranch",
          cwd,
          ["git", "fetch"],
          "Cannot sync because no git remote is configured for this JJ repository.",
        );
      }
      const beforeSha = yield* resolveCurrentCommitId(cwd);
      yield* runJj("JjCore.pullCurrentBranch.fetch", cwd, ["git", "fetch", "--remote", remoteName]);
      const bookmarks = yield* listBookmarks(cwd).pipe(Effect.catch(() => Effect.succeed([])));
      if (
        !bookmarks.some((bookmark) => bookmark.remote === remoteName && bookmark.name === branch)
      ) {
        return yield* createJjCommandError(
          "JjCore.pullCurrentBranch",
          cwd,
          ["rebase", "-b", "@", "-d", `${branch}@${remoteName}`],
          `Cannot sync because ${branch}@${remoteName} is unavailable after fetch.`,
        );
      }
      yield* runJj("JjCore.pullCurrentBranch.rebase", cwd, [
        "rebase",
        "-b",
        "@",
        "-d",
        `${branch}@${remoteName}`,
      ]);
      const afterSha = yield* resolveCurrentCommitId(cwd);
      return {
        status: beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: `${remoteName}/${branch}`,
      };
    });

  const readRangeContext: JjCoreShape["readRangeContext"] = (cwd, baseBranch) =>
    Effect.all(
      [
        runJjStdout(
          "JjCore.readRangeContext.log",
          cwd,
          [
            "log",
            "--no-graph",
            "-r",
            `${baseBranch}..@`,
            "-T",
            'commit_id.short() ++ " " ++ description.first_line() ++ "\n"',
          ],
          {
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        ),
        runJjStdout(
          "JjCore.readRangeContext.diffStat",
          cwd,
          ["diff", "--stat", "--from", baseBranch],
          {
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        ),
        runJjStdout(
          "JjCore.readRangeContext.diffPatch",
          cwd,
          ["diff", "--git", "--from", baseBranch],
          {
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([commitSummary, diffSummary, diffPatch]) => ({
        commitSummary,
        diffSummary,
        diffPatch,
      })),
    );

  const listBranches: JjCoreShape["listBranches"] = (input) =>
    Effect.gen(function* () {
      const rootResult = yield* executeJj("JjCore.listBranches.root", input.cwd, ["root"], {
        allowNonZeroExit: true,
      });
      if (rootResult.code !== 0) {
        const rootError = createJjCommandError(
          "JjCore.listBranches.root",
          input.cwd,
          ["root"],
          rootResult.stderr,
        );
        if (isNotJjRepositoryError(rootError)) {
          return {
            branches: [],
            isRepo: false,
            hasOriginRemote: false,
            nextCursor: null,
            totalCount: 0,
          };
        }
        return yield* rootError;
      }
      const [currentBookmarks, bookmarks, remoteNames, defaultBookmark] = yield* Effect.all(
        [
          resolveCurrentBookmarks(input.cwd).pipe(Effect.catch(() => Effect.succeed<string[]>([]))),
          listBookmarks(input.cwd),
          listRemoteNames(input.cwd).pipe(Effect.catch(() => Effect.succeed<string[]>([]))),
          resolveDefaultBookmark(input.cwd),
        ],
        { concurrency: "unbounded" },
      );
      const currentBookmarkSet = new Set(currentBookmarks);
      const branches = dedupeRemoteBranchesWithLocalMatches(
        bookmarks.map((bookmark) => {
          if (bookmark.remote !== null) {
            return {
              name: `${bookmark.remote}/${bookmark.name}`,
              isRemote: true,
              remoteName: bookmark.remote,
              current: false,
              isDefault: bookmark.name === defaultBookmark,
              worktreePath: null,
            };
          }
          return {
            name: bookmark.name,
            isRemote: false,
            current: currentBookmarkSet.has(bookmark.name),
            isDefault: bookmark.name === defaultBookmark,
            worktreePath: null,
          };
        }),
      ).toSorted((left, right) => {
        const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
        const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return left.name.localeCompare(right.name);
      });
      const page = paginateBranches({
        branches,
        query: input.query,
        cursor: input.cursor,
        limit: input.limit,
      });
      return {
        branches: [...page.branches],
        isRepo: true,
        vcs: "jj" as const,
        hasOriginRemote: remoteNames.includes("origin"),
        nextCursor: page.nextCursor,
        totalCount: page.totalCount,
      };
    });

  const resolveCurrentOperationId = (cwd: string) =>
    runJjStdout("JjCore.resolveCurrentOperationId", cwd, [
      "op",
      "log",
      "--no-graph",
      "--limit",
      "1",
      "-T",
      'id.short() ++ "\n"',
    ]).pipe(Effect.map((stdout) => stdout.trim()));

  const readCommitGraphNode = (cwd: string, changeId: string) =>
    runJjStdout("JjCore.commitGraph.node", cwd, [
      "log",
      "--no-graph",
      "--limit",
      "1",
      "-r",
      changeId,
      "-T",
      COMMIT_GRAPH_NODE_TEMPLATE,
    ]).pipe(
      Effect.flatMap((stdout) =>
        Effect.try({
          try: () => parseCommitGraphNode(splitLines(stdout)[0] ?? ""),
          catch: (cause) =>
            createJjCommandError(
              "JjCore.commitGraph.node",
              cwd,
              ["log", "--no-graph", "--limit", "1", "-r", changeId],
              cause instanceof Error ? cause.message : "Failed to parse JJ graph node.",
              cause,
            ),
        }),
      ),
    );

  const commitGraph: JjCoreShape["commitGraph"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.min(input.limit ?? COMMIT_GRAPH_DEFAULT_LIMIT, COMMIT_GRAPH_MAX_LIMIT);
      const revset = input.revset?.trim() || defaultCommitGraphRevset(limit + 1);
      const stdout = yield* runJjStdout("JjCore.commitGraph", input.cwd, [
        "log",
        "--no-graph",
        "--color",
        "never",
        "--limit",
        String(limit + 1),
        "-r",
        revset,
        "-T",
        COMMIT_GRAPH_NODE_TEMPLATE,
      ]);
      const currentOperationId = yield* resolveCurrentOperationId(input.cwd);
      const nodes = yield* Effect.try({
        try: () => splitLines(stdout).map(parseCommitGraphNode),
        catch: (cause) =>
          createJjCommandError(
            "JjCore.commitGraph",
            input.cwd,
            ["log", "--no-graph", "--limit", String(limit + 1), "-r", revset],
            cause instanceof Error ? cause.message : "Failed to parse JJ commit graph.",
            cause,
          ),
      });
      const visibleNodes = nodes.slice(0, limit);
      return {
        isRepo: true,
        vcs: "jj" as const,
        supported: true,
        revset,
        limit,
        hasMore: nodes.length > limit,
        currentOperationId,
        nodes: visibleNodes,
        edges: deriveCommitGraphEdges(visibleNodes),
      };
    });

  const commitGraphChangeDetails: JjCoreShape["commitGraphChangeDetails"] = (input) =>
    Effect.gen(function* () {
      const [node, changedFilesSummary, diffStat, diffPreviewResult] = yield* Effect.all(
        [
          readCommitGraphNode(input.cwd, input.changeId),
          runJjStdout("JjCore.commitGraph.details.summary", input.cwd, [
            "diff",
            "--summary",
            "-r",
            input.changeId,
          ]),
          runJjStdout("JjCore.commitGraph.details.stat", input.cwd, [
            "diff",
            "--stat",
            "-r",
            input.changeId,
          ]),
          executeJj(
            "JjCore.commitGraph.details.diff",
            input.cwd,
            ["show", "--git", "--context", "3", "-r", input.changeId],
            {
              maxOutputBytes: COMMIT_GRAPH_DIFF_PREVIEW_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
        ],
        { concurrency: "unbounded" },
      );
      return {
        node,
        changedFilesSummary,
        diffStat,
        diffPreview: diffPreviewResult.stdout,
        diffPreviewTruncated: diffPreviewResult.stdoutTruncated,
      };
    });

  const runGraphActionCommand = (
    cwd: string,
    action: GitCommitGraphAction,
  ): Effect.Effect<void, GitCommandError> => {
    switch (action.kind) {
      case "edit":
        return runJj("JjCore.commitGraph.action.edit", cwd, ["edit", action.changeId]);
      case "describe":
        return runJj("JjCore.commitGraph.action.describe", cwd, [
          "describe",
          "-r",
          action.changeId,
          "-m",
          action.message,
        ]);
      case "new": {
        const args = [
          "new",
          ...action.parentChangeIds,
          ...(action.message !== undefined ? ["-m", action.message] : []),
          ...(action.edit === false ? ["--no-edit"] : []),
        ];
        return runJj("JjCore.commitGraph.action.new", cwd, args);
      }
      case "insert_new": {
        const insertFlag = action.position === "after" ? "-A" : "-B";
        return runJj("JjCore.commitGraph.action.insertNew", cwd, [
          "new",
          insertFlag,
          action.changeId,
          ...(action.message !== undefined ? ["-m", action.message] : []),
        ]);
      }
      case "abandon": {
        const args = ["abandon", ...action.changeIds];
        return requireConfirmed("JjCore.commitGraph.action.abandon", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.abandon", cwd, args)),
        );
      }
      case "duplicate": {
        if (
          (action.destinationMode === undefined) !==
          (action.destinationChangeIds === undefined || action.destinationChangeIds.length === 0)
        ) {
          return Effect.fail(
            createJjCommandError(
              "JjCore.commitGraph.action.duplicate",
              cwd,
              ["duplicate", ...action.changeIds],
              "Duplicate destination requires both a destination mode and at least one destination change.",
            ),
          );
        }
        const destinationFlags =
          action.destinationMode === "onto"
            ? action.destinationChangeIds?.flatMap((changeId) => ["-o", changeId])
            : action.destinationMode === "after"
              ? action.destinationChangeIds?.flatMap((changeId) => ["-A", changeId])
              : action.destinationMode === "before"
                ? action.destinationChangeIds?.flatMap((changeId) => ["-B", changeId])
                : [];
        const args = ["duplicate", ...action.changeIds, ...(destinationFlags ?? [])];
        return requireConfirmed("JjCore.commitGraph.action.duplicate", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.duplicate", cwd, args)),
        );
      }
      case "rebase": {
        const modeFlag = action.mode === "source" ? "-s" : action.mode === "branch" ? "-b" : "-r";
        const destinationFlag =
          action.destinationMode === "onto"
            ? "-o"
            : action.destinationMode === "after"
              ? "-A"
              : "-B";
        const args = [
          "rebase",
          modeFlag,
          action.revset,
          ...action.destinationChangeIds.flatMap((changeId) => [destinationFlag, changeId]),
        ];
        return requireConfirmed("JjCore.commitGraph.action.rebase", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.rebase", cwd, args)),
        );
      }
      case "squash": {
        const args = ["squash", "--from", action.fromChangeId, "--into", action.intoChangeId];
        return requireConfirmed("JjCore.commitGraph.action.squash", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.squash", cwd, args)),
        );
      }
      case "split": {
        const args = [
          "split",
          "-r",
          action.changeId,
          ...(action.message !== undefined ? ["-m", action.message] : []),
          "--",
          ...action.filesets,
        ];
        return requireConfirmed("JjCore.commitGraph.action.split", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.split", cwd, args)),
        );
      }
      case "bookmark_set":
        return runJj("JjCore.commitGraph.action.bookmarkSet", cwd, [
          "bookmark",
          "set",
          action.name,
          "-r",
          action.changeId,
        ]);
      case "bookmark_move": {
        const args = ["bookmark", "move", action.name, "--to", action.changeId];
        return requireConfirmed("JjCore.commitGraph.action.bookmarkMove", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.bookmarkMove", cwd, args)),
        );
      }
      case "bookmark_rename": {
        const args = ["bookmark", "rename", action.oldName, action.newName];
        return requireConfirmed("JjCore.commitGraph.action.bookmarkRename", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.bookmarkRename", cwd, args)),
        );
      }
      case "bookmark_delete": {
        const args = ["bookmark", "delete", action.name];
        return requireConfirmed("JjCore.commitGraph.action.bookmarkDelete", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.bookmarkDelete", cwd, args)),
        );
      }
      case "bookmark_track": {
        const args = ["bookmark", "track", `${action.name}@${action.remote}`];
        return requireConfirmed("JjCore.commitGraph.action.bookmarkTrack", cwd, args, action).pipe(
          Effect.flatMap(() => runJj("JjCore.commitGraph.action.bookmarkTrack", cwd, args)),
        );
      }
      case "bookmark_untrack": {
        const args = ["bookmark", "untrack", `${action.name}@${action.remote}`];
        return requireConfirmed(
          "JjCore.commitGraph.action.bookmarkUntrack",
          cwd,
          args,
          action,
        ).pipe(Effect.flatMap(() => runJj("JjCore.commitGraph.action.bookmarkUntrack", cwd, args)));
      }
    }
  };

  const runCommitGraphAction: JjCoreShape["runCommitGraphAction"] = (input) =>
    Effect.gen(function* () {
      const currentOperationId = yield* resolveCurrentOperationId(input.cwd);
      if (currentOperationId !== input.expectedOperationId) {
        return yield* createJjCommandError(
          "JjCore.commitGraph.action.stale",
          input.cwd,
          ["op", "log", "--limit", "1"],
          "The JJ repository changed since this graph was loaded. Refresh the graph and try again.",
        );
      }
      yield* runGraphActionCommand(input.cwd, input.action);
      const operationId = yield* resolveCurrentOperationId(input.cwd);
      return {
        action: input.action,
        status: "applied" as const,
        operationId,
        ...("changeId" in input.action ? { targetChangeId: input.action.changeId } : {}),
        ...("name" in input.action ? { branch: input.action.name } : {}),
      };
    });

  const createWorktree: JjCoreShape["createWorktree"] = (input) =>
    Effect.gen(function* () {
      const targetBranch = input.newBranch ?? input.branch;
      if (input.newBranch) {
        yield* runJj("JjCore.createWorktree.bookmark", input.cwd, [
          "bookmark",
          "set",
          input.newBranch,
          "-r",
          input.branch,
        ]);
      }
      const sanitizedBranch = targetBranch.replace(/\//g, "-");
      const repoName = path.basename(input.cwd);
      const worktreePath = input.path ?? join(worktreesDir, repoName, sanitizedBranch);
      yield* runJj("JjCore.createWorktree", input.cwd, [
        "workspace",
        "add",
        worktreePath,
        "-r",
        targetBranch,
        "--name",
        sanitizeWorkspaceName(sanitizedBranch),
      ]);
      return {
        worktree: {
          path: worktreePath,
          branch: targetBranch,
        },
      };
    });

  const removeWorktree: JjCoreShape["removeWorktree"] = (input) =>
    Effect.gen(function* () {
      const workspaceName = sanitizeWorkspaceName(basename(input.path));
      yield* runJj(
        "JjCore.removeWorktree.forget",
        input.cwd,
        ["workspace", "forget", workspaceName],
        {
          allowNonZeroExit: true,
        },
      );
      yield* fileSystem
        .remove(input.path, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            createJjCommandError(
              "JjCore.removeWorktree.remove",
              input.cwd,
              ["workspace", "forget", workspaceName],
              "Failed to remove JJ workspace directory.",
              cause,
            ),
          ),
        );
    });

  const createBranch: JjCoreShape["createBranch"] = (input) =>
    runJj("JjCore.createBranch", input.cwd, ["bookmark", "set", input.branch, "-r", "@"]).pipe(
      Effect.as({ branch: input.branch }),
    );

  const checkoutBranch: JjCoreShape["checkoutBranch"] = (input) =>
    Effect.gen(function* () {
      const parsedRemote = parseRemoteBranchName(input.branch);
      if (parsedRemote) {
        const bookmarks = yield* listBookmarks(input.cwd).pipe(
          Effect.catch(() => Effect.succeed([])),
        );
        const hasRemote = bookmarks.some(
          (bookmark) =>
            bookmark.remote === parsedRemote.remoteName &&
            bookmark.name === parsedRemote.branchName,
        );
        const hasLocal = bookmarks.some(
          (bookmark) => bookmark.remote === null && bookmark.name === parsedRemote.branchName,
        );
        if (hasRemote && !hasLocal) {
          yield* runJj("JjCore.checkoutBranch.trackRemote", input.cwd, [
            "bookmark",
            "set",
            parsedRemote.branchName,
            "-r",
            `${parsedRemote.branchName}@${parsedRemote.remoteName}`,
          ]);
          yield* runJj("JjCore.checkoutBranch.editRemote", input.cwd, [
            "edit",
            parsedRemote.branchName,
          ]);
          return { branch: parsedRemote.branchName };
        }
      }
      yield* runJj("JjCore.checkoutBranch.edit", input.cwd, ["edit", input.branch]);
      return { branch: input.branch };
    });

  const initRepo: JjCoreShape["initRepo"] = (input) =>
    runJj("JjCore.initRepo", input.cwd, ["git", "init", "--colocate", input.cwd], {
      timeoutMs: 10_000,
    });

  const listLocalBranchNames: JjCoreShape["listLocalBranchNames"] = (cwd) =>
    listBookmarks(cwd, false).pipe(
      Effect.map((bookmarks) =>
        bookmarks
          .filter((bookmark) => bookmark.remote === null)
          .map((bookmark) => bookmark.name)
          .toSorted((left, right) => left.localeCompare(right)),
      ),
    );

  return {
    isJjRepository,
    status,
    statusDetails,
    statusDetailsLocal,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    listBranches,
    commitGraph,
    commitGraphChangeDetails,
    runCommitGraphAction,
    createWorktree,
    removeWorktree,
    createBranch,
    checkoutBranch,
    initRepo,
    listLocalBranchNames,
  } satisfies JjCoreShape;
});

export const JjCoreLive = Layer.effect(JjCore, makeJjCore());
