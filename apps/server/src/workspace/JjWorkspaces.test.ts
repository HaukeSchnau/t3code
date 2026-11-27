// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { inspectJjWorkspace } from "./JjWorkspaces.ts";

const run = (cwd: string, command: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

/** A colocated jj repository whose only change is on `main@origin`. */
function pushedRepository() {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jj-inspect-")),
  );
  run(base, "git", "init", "--bare", "remote.git");
  const root = NodePath.join(base, "repo");
  run(base, "jj", "git", "init", "--colocate", root);
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hello\n");
  run(root, "jj", "commit", "-m", "init");
  run(root, "jj", "bookmark", "create", "main", "-r", "@-");
  run(root, "jj", "git", "remote", "add", "origin", NodePath.join(base, "remote.git"));
  run(root, "jj", "git", "push", "--bookmark", "main");
  return root;
}

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("inspectJjWorkspace", () => {
  it.effect("finds nothing to keep in a repository a remote has", () =>
    Effect.gen(function* () {
      const root = pushedRepository();
      const inspection = yield* inspectJjWorkspace({ root, ownStore: true });
      assert.deepEqual(inspection.keep, null);
      assert.isTrue(inspection.unchanged);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a colocated checkout with an edit staged only in Git", () =>
    Effect.gen(function* () {
      const root = pushedRepository();
      NodeFS.writeFileSync(NodePath.join(root, "README.md"), "staged\n");
      run(root, "git", "add", "README.md");
      NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hello\n");
      const inspection = yield* inspectJjWorkspace({ root, ownStore: false });
      assert.equal(inspection.keep, "has changes staged in Git");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a fork whose own repository holds a Git stash", () =>
    Effect.gen(function* () {
      const root = pushedRepository();
      NodeFS.writeFileSync(NodePath.join(root, "README.md"), "draft\n");
      run(root, "git", "stash");
      const inspection = yield* inspectJjWorkspace({ root, ownStore: true });
      assert.equal(inspection.keep, "has a Git stash");
    }).pipe(Effect.provide(layer)),
  );
});
