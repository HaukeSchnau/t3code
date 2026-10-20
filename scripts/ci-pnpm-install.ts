#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - standalone CI step, run before dependencies exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

/**
 * Calder keeps node_modules between runs. When a package gains a patch while its unpatched copy is
 * still installed, pnpm 11.10 installs the patched variant without applying the patch. A fresh
 * node_modules over the same store applies it, so this starts from one whenever the lockfile's
 * patch set differs from the one the kept node_modules was installed with. (`--force` would also
 * install every platform's optional packages.) Drop it once pnpm applies patches on incremental
 * installs.
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
