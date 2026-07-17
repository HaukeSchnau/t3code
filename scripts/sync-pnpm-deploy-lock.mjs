#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const lockPath = NodePath.resolve(root, "pnpm-lock.yaml");
const deployLockPath = NodePath.resolve(root, "pnpm-deploy-lock.yaml");
const workspacePath = NodePath.resolve(root, "pnpm-workspace.yaml");
const check = process.argv.slice(2).includes("--check");
const expectedPnpmVersion = "11.10.0";

const version = NodeChildProcess.spawnSync("pnpm", ["--version"], {
  cwd: root,
  encoding: "utf8",
});
if (version.error) throw version.error;
if (version.status !== 0) throw new Error("Unable to determine the pnpm version");
if (version.stdout.trim() !== expectedPnpmVersion) {
  throw new Error(
    `Expected pnpm ${expectedPnpmVersion}, received ${version.stdout.trim()}. Run this command inside \`nix develop\`.`,
  );
}

const lock = NodeFS.readFileSync(lockPath);
const deployLock = NodeFS.readFileSync(deployLockPath);
const workspace = NodeFS.readFileSync(workspacePath);
let generated;

try {
  const workspaceText = workspace.toString("utf8");
  const injectedWorkspace = /(^|\n)injectWorkspacePackages:\s*true(?:\n|$)/.test(workspaceText)
    ? workspaceText
    : `${workspaceText.replace(/\n?$/, "\n")}injectWorkspacePackages: true\n`;

  NodeFS.writeFileSync(workspacePath, injectedWorkspace);
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    ["install", "--lockfile-only", "--ignore-scripts"],
    {
      cwd: root,
      env: { ...process.env, pnpm_config_trust_lockfile: "true" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm exited with status ${result.status ?? `signal ${result.signal}`}`);
  }

  generated = NodeFS.readFileSync(lockPath);
} finally {
  NodeFS.writeFileSync(lockPath, lock);
  NodeFS.writeFileSync(workspacePath, workspace);
}

try {
  NodeFS.writeFileSync(deployLockPath, generated);
  const formatter = NodeChildProcess.spawnSync(
    NodePath.resolve(root, "node_modules/.bin/vp"),
    ["check", "--fix", "--no-lint", "pnpm-deploy-lock.yaml"],
    { cwd: root, stdio: "inherit" },
  );
  if (formatter.error) throw formatter.error;
  if (formatter.status !== 0) {
    throw new Error(
      `Vite+ formatter exited with status ${formatter.status ?? `signal ${formatter.signal}`}`,
    );
  }
  generated = NodeFS.readFileSync(deployLockPath);
} catch (error) {
  NodeFS.writeFileSync(deployLockPath, deployLock);
  throw error;
}

if (check) {
  NodeFS.writeFileSync(deployLockPath, deployLock);
  if (!generated.equals(deployLock)) {
    console.error("pnpm-deploy-lock.yaml is stale; run node scripts/sync-pnpm-deploy-lock.mjs");
    process.exitCode = 1;
  } else {
    console.log("pnpm-deploy-lock.yaml is up to date");
  }
} else {
  console.log("Updated pnpm-deploy-lock.yaml");
}
