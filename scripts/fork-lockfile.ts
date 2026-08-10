#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - standalone repository CLI.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export type LockfileMode = "check" | "write";

export interface LockfileCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface LockfileCommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error;
}

export type LockfileCommandRunner = (command: LockfileCommand) => LockfileCommandResult;

export interface ForkLockfileOptions {
  readonly rootDir: string;
  readonly mode: LockfileMode;
  readonly runCommand?: LockfileCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
}

export interface ForkLockfileResult {
  readonly changed: boolean;
  readonly pnpmVersion: string;
}

const scriptRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function defaultCommandRunner(input: LockfileCommand): LockfileCommandResult {
  const result = NodeChildProcess.spawnSync(input.command, [...input.args], {
    cwd: input.cwd,
    encoding: "utf8",
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
  };
}

function expectedPnpmVersion(rootDir: string): string {
  const manifestPath = NodePath.join(rootDir, "package.json");
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
    readonly packageManager?: unknown;
  };
  if (typeof manifest.packageManager !== "string") {
    throw new Error(`Expected '${manifestPath}' to declare packageManager.`);
  }
  const match = /^pnpm@([^+]+)(?:\+.+)?$/.exec(manifest.packageManager);
  if (!match?.[1]) {
    throw new Error(
      `Expected packageManager to pin pnpm exactly, received '${manifest.packageManager}'.`,
    );
  }
  return match[1];
}

function runChecked(runner: LockfileCommandRunner, input: LockfileCommand, label: string): void {
  const result = runner(input);
  if (result.error) {
    throw new Error(`${label} failed to start.`, { cause: result.error });
  }
  if (result.status !== 0) {
    const exit = result.status === null ? `signal ${result.signal ?? "unknown"}` : result.status;
    const detail = result.stderr?.trim();
    throw new Error(`${label} exited with ${exit}.${detail ? `\n${detail}` : ""}`);
  }
}

function restoreFile(path: string, original: Buffer | null): void {
  if (original === null) {
    NodeFS.rmSync(path, { force: true });
    return;
  }
  NodeFS.writeFileSync(path, original);
}

export function runForkLockfile(options: ForkLockfileOptions): ForkLockfileResult {
  const rootDir = NodePath.resolve(options.rootDir);
  const lockfilePath = NodePath.join(rootDir, "pnpm-lock.yaml");
  const originalLockfile = NodeFS.existsSync(lockfilePath)
    ? NodeFS.readFileSync(lockfilePath)
    : null;
  const pnpmVersion = expectedPnpmVersion(rootDir);
  const runner = options.runCommand ?? defaultCommandRunner;
  const env = {
    ...process.env,
    ...options.env,
    pnpm_config_trust_lockfile: "true",
  };
  const pnpm = (args: ReadonlyArray<string>): LockfileCommand => ({
    command: "pnpm",
    args,
    cwd: rootDir,
    env,
  });

  const versionResult = runner(pnpm(["--version"]));
  if (versionResult.error) {
    throw new Error("Unable to determine the pnpm version.", { cause: versionResult.error });
  }
  if (versionResult.status !== 0) {
    throw new Error("Unable to determine the pnpm version.");
  }

  const detectedVersion = versionResult.stdout?.trim();
  if (detectedVersion !== pnpmVersion) {
    throw new Error(
      `Expected pnpm ${pnpmVersion}, received ${detectedVersion || "an unknown version"}.`,
    );
  }

  let completed = false;
  try {
    runChecked(
      runner,
      pnpm(["install", "--lockfile-only", "--ignore-scripts"]),
      "Lockfile regeneration",
    );
    if (!NodeFS.existsSync(lockfilePath)) {
      throw new Error("Lockfile regeneration did not produce pnpm-lock.yaml.");
    }
    const generatedLockfile = NodeFS.readFileSync(lockfilePath);
    runChecked(
      runner,
      pnpm(["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"]),
      "Frozen lockfile validation",
    );
    const changed = originalLockfile === null || !generatedLockfile.equals(originalLockfile);
    completed = true;

    if (options.mode === "check") {
      restoreFile(lockfilePath, originalLockfile);
      if (changed) {
        throw new Error(
          "pnpm-lock.yaml is stale; resolve manifests and pnpm-workspace.yaml, then run `pnpm run fork:lockfile`.",
        );
      }
      options.log?.("pnpm-lock.yaml is deterministic and up to date");
    } else {
      options.log?.(changed ? "Updated pnpm-lock.yaml" : "pnpm-lock.yaml is already up to date");
    }

    return { changed, pnpmVersion };
  } finally {
    if (options.mode === "check" || !completed) {
      restoreFile(lockfilePath, originalLockfile);
    }
  }
}

function parseMode(args: ReadonlyArray<string>): LockfileMode {
  const check = args.includes("--check");
  const write = args.includes("--write");
  if (check === write) {
    throw new Error("Pass exactly one of --check or --write.");
  }
  const unknown = args.filter((arg) => arg !== "--check" && arg !== "--write");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown[0]}`);
  }
  return check ? "check" : "write";
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  try {
    runForkLockfile({
      rootDir: scriptRoot,
      mode: parseMode(process.argv.slice(2)),
      log: console.log,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
