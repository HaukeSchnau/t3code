#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - standalone repository CLI.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

/** A Gitea commit status. Kiln reports the whole run as the `kiln` context. */
interface CommitStatus {
  readonly id: number;
  readonly status: string;
  readonly context: string;
  readonly url: string;
}

interface WatchOptions {
  readonly rootDir: string;
  readonly repository: string;
  readonly branch: string;
  readonly remote: string;
  readonly revision: string;
  readonly context: string;
  readonly pollMilliseconds: number;
  readonly log?: (message: string) => void;
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const scriptRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function runCommand(rootDir: string, command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) satisfies CommandResult;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${command} ${args.join(" ")} failed.${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function parseStatuses(value: unknown): ReadonlyArray<CommitStatus> {
  if (!Array.isArray(value)) {
    throw new Error("The Gitea commit status response was not a list.");
  }
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "number" ||
      typeof candidate.status !== "string" ||
      typeof candidate.context !== "string" ||
      typeof candidate.target_url !== "string"
    ) {
      throw new Error("The Gitea commit status response contained an invalid status.");
    }
    return {
      id: candidate.id,
      status: candidate.status,
      context: candidate.context,
      url: candidate.target_url,
    };
  });
}

export function newestStatus(
  statuses: ReadonlyArray<CommitStatus>,
  context: string,
): CommitStatus | undefined {
  return statuses
    .filter((status) => status.context === context)
    .toSorted((left, right) => right.id - left.id)[0];
}

function resolveRevision(rootDir: string, revision: string): string {
  const result = runCommand(rootDir, "jj", [
    "log",
    "--no-graph",
    "-r",
    revision,
    "-T",
    "commit_id",
  ]);
  if (!/^[0-9a-f]{40,64}$/.test(result)) {
    throw new Error(`Revision '${revision}' did not resolve to one commit.`);
  }
  return result;
}

function assertDescendant(rootDir: string, baseline: string, candidate: string): void {
  const result = runCommand(rootDir, "jj", [
    "log",
    "--no-graph",
    "-r",
    `${candidate} & descendants(${baseline})`,
    "-T",
    "commit_id",
  ]);
  if (result !== candidate) {
    throw new Error(
      `${candidate.slice(0, 12)} on main is not a descendant of ${baseline.slice(0, 12)}.`,
    );
  }
}

function fetchHead(options: WatchOptions, baseline: string): string {
  runCommand(options.rootDir, "jj", ["git", "fetch", "--remote", options.remote]);
  const head = resolveRevision(options.rootDir, `${options.branch}@${options.remote}`);
  assertDescendant(options.rootDir, baseline, head);
  return head;
}

function fetchStatuses(options: WatchOptions, head: string): ReadonlyArray<CommitStatus> {
  const endpoint = `/repos/${options.repository}/commits/${head}/statuses?limit=50`;
  return parseStatuses(JSON.parse(runCommand(options.rootDir, "tea", ["api", endpoint])));
}

function delay(milliseconds: number): Promise<void> {
  return NodeTimersPromises.setTimeout(milliseconds);
}

export async function watchMainCi(options: WatchOptions): Promise<CommitStatus> {
  const baseline = resolveRevision(options.rootDir, options.revision);
  let previousState = "";
  options.log?.(
    `Following the ${options.context} status from ${baseline.slice(0, 12)} on ${options.remote}/${options.branch}`,
  );

  while (true) {
    const head = fetchHead(options, baseline);
    const status = newestStatus(fetchStatuses(options, head), options.context);
    const state = status ? `${head}:${status.id}:${status.status}` : `${head}:waiting`;
    if (state !== previousState) {
      options.log?.(
        status
          ? `${head.slice(0, 12)}: ${options.context} is ${status.status} — ${status.url}`
          : `${head.slice(0, 12)}: waiting for Kiln to report ${options.context}`,
      );
      previousState = state;
    }

    if (status !== undefined && status.status !== "pending") {
      // A newer push supersedes this run; follow the descendant instead of its cancellation.
      const confirmedHead = fetchHead(options, baseline);
      if (confirmedHead !== head) {
        continue;
      }
      if (status.status === "success") {
        return status;
      }
      throw new Error(`${options.context} reported ${status.status}: ${status.url}`);
    }
    await delay(options.pollMilliseconds);
  }
}

function optionValue(args: ReadonlyArray<string>, name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseOptions(args: ReadonlyArray<string>): WatchOptions {
  const optionArgs = args[0] === "--" ? args.slice(1) : args;
  const known = new Set([
    "--repository",
    "--branch",
    "--remote",
    "--revision",
    "--context",
    "--poll-seconds",
  ]);
  for (let index = 0; index < optionArgs.length; index += 2) {
    if (!known.has(optionArgs[index] ?? "")) {
      throw new Error(`Unknown argument: ${optionArgs[index] ?? ""}`);
    }
  }
  const pollSeconds = Number(optionValue(optionArgs, "--poll-seconds", "30"));
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new Error("--poll-seconds must be a positive number.");
  }
  return {
    rootDir: scriptRoot,
    repository: optionValue(optionArgs, "--repository", "schnau/t3code"),
    branch: optionValue(optionArgs, "--branch", "main"),
    remote: optionValue(optionArgs, "--remote", "origin"),
    revision: optionValue(optionArgs, "--revision", "main@origin"),
    context: optionValue(optionArgs, "--context", "kiln"),
    pollMilliseconds: pollSeconds * 1_000,
    log: console.log,
  };
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  watchMainCi(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
