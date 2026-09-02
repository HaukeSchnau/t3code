#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - standalone repository CLI.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

interface WorkflowRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly headSha: string;
  readonly path: string;
  readonly url: string;
}

interface WatchOptions {
  readonly rootDir: string;
  readonly repository: string;
  readonly branch: string;
  readonly remote: string;
  readonly revision: string;
  readonly workflow: string;
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

export function parseWorkflowRuns(value: unknown): ReadonlyArray<WorkflowRun> {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs)) {
    throw new Error("The Gitea Actions response did not contain workflow_runs.");
  }
  return value.workflow_runs.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "number" ||
      typeof candidate.status !== "string" ||
      typeof candidate.head_sha !== "string" ||
      typeof candidate.path !== "string" ||
      typeof candidate.html_url !== "string" ||
      (candidate.conclusion !== undefined &&
        candidate.conclusion !== null &&
        typeof candidate.conclusion !== "string")
    ) {
      throw new Error("The Gitea Actions response contained an invalid workflow run.");
    }
    return {
      id: candidate.id,
      status: candidate.status,
      ...(candidate.conclusion !== undefined ? { conclusion: candidate.conclusion } : {}),
      headSha: candidate.head_sha,
      path: candidate.path,
      url: candidate.html_url,
    };
  });
}

export function newestRunForCommit(
  runs: ReadonlyArray<WorkflowRun>,
  headSha: string,
  workflow: string,
): WorkflowRun | undefined {
  return runs
    .filter((run) => run.headSha === headSha && run.path.startsWith(`${workflow}@`))
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

function fetchRuns(options: WatchOptions): ReadonlyArray<WorkflowRun> {
  const endpoint = `/repos/${options.repository}/actions/runs?branch=${encodeURIComponent(options.branch)}&limit=50`;
  return parseWorkflowRuns(JSON.parse(runCommand(options.rootDir, "tea", ["api", endpoint])));
}

function delay(milliseconds: number): Promise<void> {
  return NodeTimersPromises.setTimeout(milliseconds);
}

export async function watchMainCi(options: WatchOptions): Promise<WorkflowRun> {
  const baseline = resolveRevision(options.rootDir, options.revision);
  let previousState = "";
  options.log?.(
    `Following ${options.workflow} from ${baseline.slice(0, 12)} on ${options.remote}/${options.branch}`,
  );

  while (true) {
    const head = fetchHead(options, baseline);
    const run = newestRunForCommit(fetchRuns(options), head, options.workflow);
    const state = run
      ? `${head}:${run.id}:${run.status}:${run.conclusion ?? ""}`
      : `${head}:pending`;
    if (state !== previousState) {
      options.log?.(
        run
          ? `${head.slice(0, 12)}: run ${run.id} is ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""} — ${run.url}`
          : `${head.slice(0, 12)}: waiting for ${options.workflow} to start`,
      );
      previousState = state;
    }

    if (run?.status === "completed") {
      const confirmedHead = fetchHead(options, baseline);
      if (confirmedHead !== head) {
        continue;
      }
      if (run.conclusion === "success") {
        return run;
      }
      throw new Error(
        `Run ${run.id} completed with ${run.conclusion ?? "an unknown conclusion"}: ${run.url}`,
      );
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

function parseOptions(args: ReadonlyArray<string>): WatchOptions {
  const known = new Set([
    "--repository",
    "--branch",
    "--remote",
    "--revision",
    "--workflow",
    "--poll-seconds",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index] ?? "")) {
      throw new Error(`Unknown argument: ${args[index] ?? ""}`);
    }
  }
  const pollSeconds = Number(optionValue(args, "--poll-seconds", "30"));
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new Error("--poll-seconds must be a positive number.");
  }
  return {
    rootDir: scriptRoot,
    repository: optionValue(args, "--repository", "schnau/t3code"),
    branch: optionValue(args, "--branch", "main"),
    remote: optionValue(args, "--remote", "origin"),
    revision: optionValue(args, "--revision", "main@origin"),
    workflow: optionValue(args, "--workflow", "project-release.yml"),
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
