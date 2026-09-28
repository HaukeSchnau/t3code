// @effect-diagnostics nodeBuiltinImport:off - Drives the real CI runner script with real processes and signals.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";
import { expect, it, onTestFinished } from "vite-plus/test";

const runner = NodePath.join(import.meta.dirname, "ci-workspace-run.sh");

// Catches SIGTERM and keeps running, as TypeScript 7's native tsc does until its check ends. The
// command also spawns one such child in its session and one in a new session, then prints all PIDs.
const termCatchingTree = `
const { spawn } = require("node:child_process");
const keepRunning = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
const sameSession = spawn(process.execPath, ["-e", keepRunning], { stdio: "ignore" });
const ownSession = spawn(process.execPath, ["-e", keepRunning], { stdio: "ignore", detached: true });
process.on("SIGTERM", () => {});
console.log([process.pid, sameSession.pid, ownSession.pid].join(" "));
setInterval(() => {}, 1000);
`;

function isRunning(pid: number): boolean {
  try {
    const state = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
    return state !== undefined && state !== "Z";
  } catch {
    return false;
  }
}

it.skipIf(NodeProcess.platform !== "linux")(
  "kills a cancelled command tree that keeps running after SIGTERM",
  async () => {
    const supervisor = NodeChildProcess.spawn(
      runner,
      ["--internal-supervise", NodeProcess.execPath, "-e", termCatchingTree],
      {
        env: { ...NodeProcess.env, CI_CANCEL_GRACE_SECONDS: "1" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const pids: Array<number> = [];
    // Runs even when the test times out, so a regression cannot leak the tree it tests.
    onTestFinished(() => {
      for (const pid of [supervisor.pid, ...pids]) {
        if (pid === undefined) continue;
        try {
          NodeProcess.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
    const exitCode = new Promise<number | null>((resolve) => supervisor.once("exit", resolve));
    const line = await new Promise<string>((resolve) =>
      NodeReadline.createInterface({ input: supervisor.stdout }).once("line", resolve),
    );
    pids.push(...line.split(" ").map(Number));

    supervisor.kill("SIGTERM");
    // 137: the command itself ignored TERM and was killed once the grace period ran out.
    expect(await exitCode).toBe(137);
    await expect.poll(() => pids.filter(isRunning)).toEqual([]);
  },
);
