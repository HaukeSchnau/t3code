#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - standalone repository CLI.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const dependencyNames = ["web", "server", "runtime"] as const;

export type DependencyName = (typeof dependencyNames)[number];
export type DependencyHashes = Readonly<Record<DependencyName, string>>;

function isDependencyName(value: string): value is DependencyName {
  return dependencyNames.some((name) => name === value);
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
}

interface CommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type AsyncCommandRunner = (input: CommandInput) => Promise<CommandResult>;

export interface RefreshPnpmDepsHashesOptions {
  readonly rootDir: string;
  readonly runCommand?: AsyncCommandRunner;
  readonly verify?: boolean;
  readonly log?: (message: string) => void;
}

const scriptRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function defaultCommandRunner(input: CommandInput): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, stdout, stderr, signal }));
  });
}

function commandFailure(label: string, result: CommandResult): Error {
  const exit =
    result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.code}`;
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(`${label} failed with ${exit}.${detail ? `\n${detail}` : ""}`);
}

export function parseExpectedHashes(output: string): DependencyHashes {
  const hashes = new Map<DependencyName, string>();
  const mismatch =
    /hash mismatch in fixed-output derivation '[^']*t3code-(web|server|runtime)-deps-[^']*':[\s\S]*?\bgot:\s*(sha256-[A-Za-z0-9+/=]+)/g;
  for (const match of output.matchAll(mismatch)) {
    const [, name, hash] = match;
    if (name && hash && isDependencyName(name)) hashes.set(name, hash);
  }
  const web = hashes.get("web");
  const server = hashes.get("server");
  const runtime = hashes.get("runtime");
  if (!web || !server || !runtime) {
    throw new Error("Nix did not report all three expected fixed-output hashes.");
  }
  return { web, server, runtime };
}

export function updatePnpmDepsHashes(source: string, hashes: DependencyHashes): string {
  const blockStart = source.indexOf("pnpmDepsHashes ? {");
  const relativeBlockEnd = source.slice(blockStart).search(/\n\s*},/);
  if (blockStart === -1 || relativeBlockEnd === -1) {
    throw new Error("Could not find the pnpmDepsHashes defaults in flake.nix.");
  }
  const blockEnd = blockStart + relativeBlockEnd;

  const before = source.slice(0, blockStart);
  let block = source.slice(blockStart, blockEnd);
  const after = source.slice(blockEnd);
  for (const name of dependencyNames) {
    const pattern = new RegExp(`(\\n\\s*${name} = ")[^"]+(";)`);
    if (!pattern.test(block)) {
      throw new Error(`Could not find the ${name} pnpm dependency hash in flake.nix.`);
    }
    block = block.replace(pattern, `$1${hashes[name]}$2`);
  }
  return before + block + after;
}

async function calculateHashes(
  rootDir: string,
  system: string,
  runCommand: AsyncCommandRunner,
): Promise<DependencyHashes> {
  const result = await runCommand({
    command: "nix",
    args: [
      "build",
      "--keep-going",
      "--max-jobs",
      "auto",
      "--no-link",
      `.#legacyPackages.${system}.pnpmDepsForHashRefresh.web`,
      `.#legacyPackages.${system}.pnpmDepsForHashRefresh.server`,
      `.#legacyPackages.${system}.pnpmDepsForHashRefresh.runtime`,
    ],
    cwd: rootDir,
    env: { ...process.env, NO_COLOR: "1" },
  });
  try {
    return parseExpectedHashes(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    if (result.code !== 0) {
      throw commandFailure("Calculating the pnpm dependency hashes", result);
    }
    throw error;
  }
}

async function runChecked(
  runCommand: AsyncCommandRunner,
  input: CommandInput,
  label: string,
): Promise<string> {
  const result = await runCommand(input);
  if (result.code !== 0) {
    throw commandFailure(label, result);
  }
  return result.stdout.trim();
}

function copyTrackedFile(rootDir: string, destinationRoot: string, relativePath: string): void {
  if (
    NodePath.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${NodePath.sep}`)
  ) {
    throw new Error(`Jujutsu reported an unsafe tracked path: ${relativePath}`);
  }
  const sourcePath = NodePath.join(rootDir, relativePath);
  const destinationPath = NodePath.join(destinationRoot, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
  const metadata = NodeFS.lstatSync(sourcePath);
  if (metadata.isSymbolicLink()) {
    NodeFS.symlinkSync(NodeFS.readlinkSync(sourcePath), destinationPath);
    return;
  }
  NodeFS.copyFileSync(sourcePath, destinationPath);
  NodeFS.chmodSync(destinationPath, metadata.mode);
}

async function withBuildSource<Result>(
  rootDir: string,
  runCommand: AsyncCommandRunner,
  env: NodeJS.ProcessEnv,
  useSource: (sourceRoot: string) => Promise<Result>,
): Promise<Result> {
  if (NodeFS.existsSync(NodePath.join(rootDir, ".git"))) {
    return useSource(rootDir);
  }

  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-nix-source-"));
  const sourceRoot = NodePath.join(temporaryRoot, "source");
  try {
    const trackedFiles = await runChecked(
      runCommand,
      {
        command: "jj",
        args: ["file", "list", "--revision", "@"],
        cwd: rootDir,
        env,
      },
      "Listing the tracked working copy",
    );
    NodeFS.mkdirSync(sourceRoot);
    for (const relativePath of trackedFiles.split("\n").filter(Boolean)) {
      copyTrackedFile(rootDir, sourceRoot, relativePath);
    }
    return await useSource(sourceRoot);
  } finally {
    NodeFS.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

async function resolveSystem(
  sourceRoot: string,
  runCommand: AsyncCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return runChecked(
    runCommand,
    {
      command: "nix",
      args: ["eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
      cwd: sourceRoot,
      env,
    },
    "Resolving the current Nix system",
  );
}

export async function checkPnpmDepsHashes(options: RefreshPnpmDepsHashesOptions): Promise<void> {
  const rootDir = NodePath.resolve(options.rootDir);
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const env = { ...process.env, NO_COLOR: "1" };
  await withBuildSource(rootDir, runCommand, env, async (sourceRoot) => {
    await runChecked(
      runCommand,
      {
        command: "nix",
        args: [
          "build",
          ".#t3code.pnpmDeps.web",
          ".#t3code.pnpmDeps.server",
          ".#t3code.pnpmDeps.runtime",
          "--no-link",
          "--print-build-logs",
        ],
        cwd: sourceRoot,
        env,
      },
      "Checking the pnpm dependency hashes",
    );
  });
  options.log?.("Verified the web, server, and runtime pnpm dependency hashes");
}

export async function refreshPnpmDepsHashes(
  options: RefreshPnpmDepsHashesOptions,
): Promise<DependencyHashes> {
  const rootDir = NodePath.resolve(options.rootDir);
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const env = { ...process.env, NO_COLOR: "1" };
  return withBuildSource(rootDir, runCommand, env, async (sourceRoot) => {
    const system = await resolveSystem(sourceRoot, runCommand, env);
    const hashes = await calculateHashes(sourceRoot, system, runCommand);
    const flakePath = NodePath.join(rootDir, "flake.nix");
    const source = NodeFS.readFileSync(flakePath, "utf8");
    const updated = updatePnpmDepsHashes(source, hashes);
    if (updated !== source) {
      const temporaryPath = `${flakePath}.tmp-${process.pid}`;
      try {
        NodeFS.writeFileSync(temporaryPath, updated);
        NodeFS.renameSync(temporaryPath, flakePath);
      } finally {
        NodeFS.rmSync(temporaryPath, { force: true });
      }
      options.log?.("Updated the web, server, and runtime pnpm dependency hashes in flake.nix");
    } else {
      options.log?.("The pnpm dependency hashes are already up to date");
    }

    if (options.verify !== false) {
      const buildFlakePath = NodePath.join(sourceRoot, "flake.nix");
      if (buildFlakePath !== flakePath) {
        NodeFS.writeFileSync(
          buildFlakePath,
          updatePnpmDepsHashes(NodeFS.readFileSync(buildFlakePath, "utf8"), hashes),
        );
      }
      await runChecked(
        runCommand,
        {
          command: "nix",
          args: [
            "build",
            `.#checks.${system}.projectReleaseGate`,
            "--no-link",
            "--print-build-logs",
          ],
          cwd: sourceRoot,
          env,
        },
        "Verifying the release contract",
      );
      options.log?.("Verified the Nix release contract");
    }
    return hashes;
  });
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const operation =
    args.length === 0
      ? refreshPnpmDepsHashes({ rootDir: scriptRoot, log: console.log })
      : args.length === 1 && args[0] === "--check"
        ? checkPnpmDepsHashes({ rootDir: scriptRoot, log: console.log })
        : Promise.reject(new Error(`Unknown arguments: ${args.join(" ")}`));
  operation.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
