// @effect-diagnostics nodeBuiltinImport:off - exercises the filesystem-preserving CLI workflow.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  runForkLockfile,
  type LockfileCommand,
  type LockfileCommandResult,
} from "./fork-lockfile.ts";

function makeFixture(): string {
  const rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-lockfile-"));
  NodeFS.writeFileSync(
    NodePath.join(rootDir, "package.json"),
    `${JSON.stringify({ packageManager: "pnpm@11.10.0" }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(rootDir, "pnpm-workspace.yaml"), "packages: []\n");
  NodeFS.writeFileSync(NodePath.join(rootDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  NodeFS.writeFileSync(NodePath.join(rootDir, "keep.txt"), "unchanged\n");
  return rootDir;
}

function snapshotTree(rootDir: string): ReadonlyArray<readonly [string, string]> {
  return NodeFS.readdirSync(rootDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const relativePath = NodePath.relative(rootDir, NodePath.join(entry.parentPath, entry.name));
      return [
        relativePath,
        NodeFS.readFileSync(NodePath.join(rootDir, relativePath), "base64"),
      ] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

function workflowRunner(input: {
  readonly rootDir: string;
  readonly generatedLockfile?: string;
  readonly failAt?: "generate" | "validate";
  readonly commands: LockfileCommand[];
}) {
  return (command: LockfileCommand): LockfileCommandResult => {
    input.commands.push(command);
    if (command.args[0] === "--version") {
      return { status: 0, stdout: "11.10.0\n" };
    }
    const frozen = command.args.includes("--frozen-lockfile");
    NodeFS.writeFileSync(
      NodePath.join(input.rootDir, "pnpm-lock.yaml"),
      input.generatedLockfile ?? "lockfileVersion: '9.0'\n",
    );
    if ((!frozen && input.failAt === "generate") || (frozen && input.failAt === "validate")) {
      return { status: 23, stderr: "induced failure" };
    }
    return { status: 0 };
  };
}

describe("fork lockfile workflow", () => {
  it("checks regeneration and frozen validation without changing any repository bytes", () => {
    const rootDir = makeFixture();
    const before = snapshotTree(rootDir);
    const commands: LockfileCommand[] = [];

    const result = runForkLockfile({
      rootDir,
      mode: "check",
      runCommand: workflowRunner({ rootDir, commands }),
    });

    assert.deepStrictEqual(result, { changed: false, pnpmVersion: "11.10.0" });
    assert.deepStrictEqual(snapshotTree(rootDir), before);
    assert.deepStrictEqual(
      commands.map((command) => command.args),
      [
        ["--version"],
        ["install", "--lockfile-only", "--ignore-scripts"],
        ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"],
      ],
    );
    assert.ok(commands.every((command) => command.env.pnpm_config_trust_lockfile === "true"));
  });

  it("reports a stale generated lockfile and restores the tree", () => {
    const rootDir = makeFixture();
    const before = snapshotTree(rootDir);

    assert.throws(
      () =>
        runForkLockfile({
          rootDir,
          mode: "check",
          runCommand: workflowRunner({
            rootDir,
            generatedLockfile: "lockfileVersion: '9.0'\nchanged: true\n",
            commands: [],
          }),
        }),
      /pnpm-lock\.yaml is stale/,
    );
    assert.deepStrictEqual(snapshotTree(rootDir), before);
  });

  it("restores the tree when regeneration or frozen validation fails", () => {
    for (const failAt of ["generate", "validate"] as const) {
      const rootDir = makeFixture();
      const before = snapshotTree(rootDir);

      assert.throws(
        () =>
          runForkLockfile({
            rootDir,
            mode: "check",
            runCommand: workflowRunner({
              rootDir,
              generatedLockfile: "corrupted by induced failure\n",
              failAt,
              commands: [],
            }),
          }),
        /induced failure/,
      );
      assert.deepStrictEqual(snapshotTree(rootDir), before);
    }
  });

  it("restores the original lockfile when write-mode validation fails", () => {
    const rootDir = makeFixture();
    const before = snapshotTree(rootDir);

    assert.throws(
      () =>
        runForkLockfile({
          rootDir,
          mode: "write",
          runCommand: workflowRunner({
            rootDir,
            generatedLockfile: "invalid generated lockfile\n",
            failAt: "validate",
            commands: [],
          }),
        }),
      /Frozen lockfile validation/,
    );
    assert.deepStrictEqual(snapshotTree(rootDir), before);
  });

  it("keeps a regenerated lockfile only after frozen validation succeeds in write mode", () => {
    const rootDir = makeFixture();
    const commands: LockfileCommand[] = [];
    const generatedLockfile = "lockfileVersion: '9.0'\nimporters: {}\n";

    const result = runForkLockfile({
      rootDir,
      mode: "write",
      runCommand: workflowRunner({ rootDir, generatedLockfile, commands }),
    });

    assert.deepStrictEqual(result, { changed: true, pnpmVersion: "11.10.0" });
    assert.equal(
      NodeFS.readFileSync(NodePath.join(rootDir, "pnpm-lock.yaml"), "utf8"),
      generatedLockfile,
    );
    assert.ok(commands.at(-1)?.args.includes("--frozen-lockfile"));
  });

  it("rejects a pnpm version that differs from packageManager before regeneration", () => {
    const rootDir = makeFixture();
    const commands: LockfileCommand[] = [];

    assert.throws(
      () =>
        runForkLockfile({
          rootDir,
          mode: "check",
          runCommand: (command) => {
            commands.push(command);
            return { status: 0, stdout: "11.9.0\n" };
          },
        }),
      /Expected pnpm 11\.10\.0, received 11\.9\.0/,
    );
    assert.equal(commands.length, 1);
  });
});
