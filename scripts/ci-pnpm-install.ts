#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - standalone CI step, run before dependencies exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

/**
 * pnpm (seen on 11.10) installs a newly patched package without applying the patch while its
 * unpatched copy sits in Calder's kept node_modules, so start fresh whenever the lockfile's patch
 * set changes. `--force` would also install every platform's optional packages. Drop this once
 * pnpm applies patches on incremental installs.
 */
const marker = "node_modules/.t3-patch-set";
const lockfile = NodeFS.readFileSync("pnpm-lock.yaml", "utf8");
const patchSet = /^patchedDependencies:\n(?: {2}.*\n)*/m.exec(lockfile)?.[0] ?? "";
const installedPatchSet = NodeFS.existsSync(marker) ? NodeFS.readFileSync(marker, "utf8") : null;

if (installedPatchSet !== patchSet) {
  NodeFS.rmSync("node_modules", { recursive: true, force: true });
  for (const dir of NodeFS.globSync(["*/node_modules", "*/*/node_modules"])) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

const result = NodeChildProcess.spawnSync(
  "pnpm",
  ["install", "--frozen-lockfile", "--trust-lockfile"],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  NodeFS.writeFileSync(marker, patchSet);
}
