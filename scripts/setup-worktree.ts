// @effect-diagnostics nodeBuiltinImport:off -- bootstraps dependencies before an Effect runtime is available.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function run(command: string, args: string[]) {
  const result = NodeChildProcess.spawnSync(command, args, {
    // Setup has no one answering prompts. A closed stdin makes a prompt fail instead of hanging.
    stdio: ["ignore", "inherit", "inherit"],
    // pnpm uses a .cmd shim on Windows; its fixed install command needs a shell.
    // oxlint-disable-next-line t3code/no-global-process-runtime -- runs before workspace dependencies are installed.
    shell: process.platform === "win32" && command === "pnpm",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Native entry already runs this task. Recheck its inputs instead of installing twice.
if (
  process.env.DEVENV_ROOT &&
  NodeFS.realpathSync(process.env.DEVENV_ROOT) === NodeFS.realpathSync(process.cwd())
) {
  run("devenv", ["--no-tui", "tasks", "run", "t3:dependencies"]);
} else {
  run("pnpm", ["install", "--frozen-lockfile", "--yes"]);
}

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (projectRoot && NodeFS.existsSync(projectRoot)) {
  const sourceRoot = NodeFS.realpathSync(projectRoot);
  const workspaceRoot = NodeFS.realpathSync(process.cwd());
  // Isolated workspaces use their own project root and have no source checkout mount.
  if (sourceRoot !== workspaceRoot) {
    for (const relative of [".env", NodePath.join("infra", "relay", ".env")]) {
      const source = NodePath.join(sourceRoot, relative);
      const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
      if (!sourceStat) continue;
      if (!sourceStat.isFile()) {
        process.stderr.write(`Skipping ${relative}: ${source} is not a regular file.\n`);
        continue;
      }
      // Only a symlink is ever replaced, so a real env file in the workspace is never deleted.
      const target = NodePath.join(workspaceRoot, relative);
      const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
      if (existing && !existing.isSymbolicLink()) continue;
      if (existing) NodeFS.rmSync(target);
      NodeFS.symlinkSync(source, target, "file");
    }
  }
}
