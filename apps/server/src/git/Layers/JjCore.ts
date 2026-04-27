import { basename, join } from "node:path";

import { Effect, FileSystem, Layer, Path } from "effect";
import type { GitBranch } from "@t3tools/contracts";
import { GitCommandError } from "@t3tools/contracts";

import { runProcess } from "../../processRunner.ts";
import { ServerConfig } from "../../config.ts";
import { JjCore, type JjCoreShape } from "../Services/JjCore.ts";
import type { GitCommitOptions, GitPushResult, GitStatusDetails } from "../Services/GitCore.ts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const JJ_GLOBAL_ARGS = ["--no-pager", "--config", "revsets.short-prefixes=none()"] as const;
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const LIST_BRANCHES_DEFAULT_LIMIT = 100;
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;

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
    createWorktree,
    removeWorktree,
    createBranch,
    checkoutBranch,
    initRepo,
    listLocalBranchNames,
  } satisfies JjCoreShape;
});

export const JjCoreLive = Layer.effect(JjCore, makeJjCore());
