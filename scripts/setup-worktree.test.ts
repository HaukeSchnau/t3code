// @effect-diagnostics nodeBuiltinImport:off -- exercises the dependency bootstrap before Effect is available.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const setup = NodePath.resolve(import.meta.dirname, "setup-worktree.ts");

it.effect(
  "reuses native dependency checks, preserves ordinary installs, and stops on failure",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-setup-test-"));
      try {
        NodeFS.mkdirSync(NodePath.join(root, "bin"));
        for (const name of ["pnpm", "devenv"]) {
          NodeFS.writeFileSync(
            NodePath.join(root, "bin", name),
            `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" >> "$SETUP_TEST_LOG"\nexit "\${SETUP_TEST_EXIT:-0}"\n`,
            { mode: 0o755 },
          );
        }
        const log = NodePath.join(root, "commands");
        const run = (native: boolean, exitCode = "0") => {
          NodeFS.writeFileSync(log, "");
          return NodeChildProcess.spawnSync(process.execPath, [setup], {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${NodePath.join(root, "bin")}:${process.env.PATH}`,
              DEVENV_ROOT: native ? root : "",
              T3CODE_PROJECT_ROOT: "",
              SETUP_TEST_LOG: log,
              SETUP_TEST_EXIT: exitCode,
            },
          });
        };
        assert.equal(run(true).status, 0);
        assert.equal(
          NodeFS.readFileSync(log, "utf8"),
          "devenv\n--no-tui\ntasks\nrun\nt3:dependencies\n",
        );
        assert.equal(run(false).status, 0);
        assert.equal(NodeFS.readFileSync(log, "utf8"), "pnpm\ninstall\n--frozen-lockfile\n");
        const failed = run(true, "7");
        assert.equal(failed.status, 7);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);
