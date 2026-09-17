// @effect-diagnostics nodeBuiltinImport:off -- bootstraps dependencies before an Effect runtime is available.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function run(command: string, args: string[]) {
  const result = NodeChildProcess.spawnSync(command, args, {
    stdio: "inherit",
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
  run("pnpm", ["install", "--frozen-lockfile"]);
}

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (projectRoot && NodeFS.existsSync(projectRoot)) {
  const sourceRoot = NodeFS.realpathSync(projectRoot);
  const workspaceRoot = NodeFS.realpathSync(process.cwd());
  // Isolated workspaces use their own project root and have no source checkout mount.
  if (sourceRoot !== workspaceRoot) {
    for (const relative of [".env", "infra/relay/.env"]) {
      const source = NodePath.join(sourceRoot, relative);
      const target = NodePath.join(workspaceRoot, relative);
      if (!NodeFS.existsSync(source) || NodeFS.lstatSync(target, { throwIfNoEntry: false })) {
        continue;
      }
      NodeFS.symlinkSync(source, target, "file");
    }
  }
}
