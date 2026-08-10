#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - standalone read-only JJ CLI.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface ReadonlyCommand {
  readonly command: "jj";
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

export type ReadonlyCommandRunner = (input: ReadonlyCommand) => string;

export interface ReconciliationReportOptions {
  readonly rootDir: string;
  readonly from: string;
  readonly to: string;
  readonly runCommand?: ReadonlyCommandRunner;
}

interface SyncMerge {
  readonly commitId: string;
  readonly description: string;
  readonly paths: ReadonlyArray<string>;
}

export interface ReconciliationReport {
  readonly from: string;
  readonly to: string;
  readonly syncMerges: ReadonlyArray<SyncMerge>;
  readonly repeatedPaths: ReadonlyArray<{ readonly path: string; readonly count: number }>;
  readonly currentForkPaths: ReadonlyArray<string>;
  readonly touchpoints: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

const scriptRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const syncMergeTitle = /^merge: sync upstream(?: main)?$/i;

function defaultCommandRunner(input: ReadonlyCommand): string {
  const result = NodeChildProcess.spawnSync(input.command, [...input.args], {
    cwd: input.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Could not run ${input.command}.`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(
      `Read-only JJ command failed: jj ${input.args.join(" ")}\n${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export function parseDiffSummary(output: string): ReadonlyArray<string> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 2)
    .map((line) => line.slice(2))
    .sort((left, right) => left.localeCompare(right));
}

function isManifestOrGeneratedTouchpoint(path: string): boolean {
  return (
    path === "package.json" ||
    path.endsWith("/package.json") ||
    path === "pnpm-workspace.yaml" ||
    path === "pnpm-lock.yaml" ||
    path === "pnpm-deploy-lock.yaml" ||
    path === "flake.nix" ||
    path === "flake.lock" ||
    path.includes("/_generated/") ||
    /(?:^|\/)routeTree\.gen\./.test(path) ||
    /\.generated\./.test(path)
  );
}

function warningsFor(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const pathSet = new Set(paths);
  const warnings: string[] = [];
  if (pathSet.has("pnpm-lock.yaml")) {
    warnings.push(
      "pnpm-lock.yaml is derived: resolve package manifests and pnpm-workspace.yaml first, then regenerate it instead of hand-merging it.",
    );
  }
  if (pathSet.has("pnpm-deploy-lock.yaml") || pathSet.has("pnpm-lock.yaml")) {
    warnings.push(
      "Check pnpm-deploy-lock.yaml with `node scripts/sync-pnpm-deploy-lock.mjs --check` after canonical lockfile changes.",
    );
  }
  if (
    pathSet.has("flake.nix") ||
    pathSet.has("flake.lock") ||
    pathSet.has("pnpm-lock.yaml") ||
    pathSet.has("pnpm-deploy-lock.yaml")
  ) {
    warnings.push(
      "Check the fixed-output pnpm dependency hashes in flake.nix after lockfile changes.",
    );
  }
  if (
    paths.some(
      (path) =>
        path.includes("/_generated/") ||
        /(?:^|\/)routeTree\.gen\./.test(path) ||
        /\.generated\./.test(path),
    )
  ) {
    warnings.push("Generated source changed; regenerate it from its authoritative inputs.");
  }
  return warnings;
}

export function collectReconciliationReport(
  options: ReconciliationReportOptions,
): ReconciliationReport {
  const rootDir = NodePath.resolve(options.rootDir);
  const run = options.runCommand ?? defaultCommandRunner;
  const invoke = (args: ReadonlyArray<string>) => run({ command: "jj", args, cwd: rootDir });
  const log = invoke([
    "log",
    "-r",
    `ancestors(${options.to}) & merges()`,
    "--no-graph",
    "-T",
    'commit_id ++ "\\t" ++ description.first_line() ++ "\\n"',
  ]);
  const mergeHeaders = log
    .split(/\r?\n/)
    .flatMap((line) => {
      const separator = line.indexOf("\t");
      if (separator < 1) return [];
      const commitId = line.slice(0, separator);
      const description = line.slice(separator + 1).trim();
      return syncMergeTitle.test(description) ? [{ commitId, description }] : [];
    })
    .sort((left, right) => left.commitId.localeCompare(right.commitId));
  const syncMerges = mergeHeaders.map((merge) => ({
    ...merge,
    paths: parseDiffSummary(invoke(["diff", "-r", merge.commitId, "--summary"])),
  }));
  const pathCounts = new Map<string, number>();
  for (const merge of syncMerges) {
    for (const path of new Set(merge.paths)) {
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
    }
  }
  const repeatedPaths = [...pathCounts]
    .filter(([, count]) => count > 1)
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
  const currentForkPaths = parseDiffSummary(
    invoke(["diff", "--from", options.from, "--to", options.to, "--summary"]),
  );
  const allPaths = [
    ...new Set([...syncMerges.flatMap((merge) => merge.paths), ...currentForkPaths]),
  ].sort((left, right) => left.localeCompare(right));
  return {
    from: options.from,
    to: options.to,
    syncMerges,
    repeatedPaths,
    currentForkPaths,
    touchpoints: allPaths.filter(isManifestOrGeneratedTouchpoint),
    warnings: warningsFor(allPaths),
  };
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderReconciliationReport(report: ReconciliationReport): string {
  const lines = [
    "# Fork reconciliation report",
    "",
    `- Base: \`${report.from}\``,
    `- Head: \`${report.to}\``,
    `- Historical upstream sync merges: ${report.syncMerges.length}`,
    `- Current fork paths: ${report.currentForkPaths.length}`,
    "",
    "## Historical sync merges",
    "",
    "| Commit | Reconciled paths | Description |",
    "| --- | ---: | --- |",
    ...report.syncMerges.map(
      (merge) =>
        `| \`${merge.commitId.slice(0, 12)}\` | ${merge.paths.length} | ${markdownCell(merge.description)} |`,
    ),
    "",
    "## Repeated reconciliation paths",
    "",
    ...(report.repeatedPaths.length > 0
      ? report.repeatedPaths.map((entry) => `- ${entry.count}× \`${entry.path}\``)
      : ["- None"]),
    "",
    "## Current fork delta",
    "",
    ...(report.currentForkPaths.length > 0
      ? report.currentForkPaths.map((path) => `- \`${path}\``)
      : ["- None"]),
    "",
    "## Manifest and generated touchpoints",
    "",
    ...(report.touchpoints.length > 0
      ? report.touchpoints.map((path) => `- \`${path}\``)
      : ["- None"]),
    "",
    "## Warnings",
    "",
    ...(report.warnings.length > 0 ? report.warnings.map((warning) => `- ${warning}`) : ["- None"]),
    "",
  ];
  return lines.join("\n");
}

function parseArgs(args: ReadonlyArray<string>): { readonly from: string; readonly to: string } {
  let from = "main@upstream";
  let to = "main";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--from" && arg !== "--to") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a revision.`);
    if (arg === "--from") from = value;
    else to = value;
    index += 1;
  }
  return { from, to };
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  try {
    const revisions = parseArgs(process.argv.slice(2));
    process.stdout.write(
      renderReconciliationReport(
        collectReconciliationReport({ rootDir: scriptRoot, ...revisions }),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
