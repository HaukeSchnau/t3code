// @effect-diagnostics nodeBuiltinImport:off -- filesystem boundary integration fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { executionLauncherForCwd } from "./ProjectExecution.ts";
import {
  isSeparateProject,
  assertSeparateProjectRootUnchanged,
} from "./SeparateProjectRegistry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true });
});

it.effect(
  "recognizes project descendants, rejects symlink escapes, and refuses an implicit move",
  () =>
    Effect.gen(function* () {
      const base = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-project-registry-")),
      );
      roots.push(base);
      const root = NodePath.join(base, "project");
      const state = NodePath.join(base, "state");
      const sibling = NodePath.join(base, "sibling");
      for (const directory of [
        root,
        sibling,
        NodePath.join(state, "projects"),
        NodePath.join(root, "src"),
      ])
        NodeFS.mkdirSync(directory, { recursive: true });
      NodeFS.symlinkSync(sibling, NodePath.join(root, "escape"));
      const id = NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 20);
      NodeFS.writeFileSync(
        NodePath.join(state, "projects", `${id}.json`),
        JSON.stringify({ version: 1, root, projectId: "project-1" }),
      );
      expect(
        yield* Effect.promise(() => isSeparateProject(NodePath.join(root, "src"), state)),
      ).toBe(true);
      expect(
        yield* Effect.promise(() => isSeparateProject(NodePath.join(root, "escape"), state)),
      ).toBe(false);
      yield* Effect.promise(() =>
        expect(assertSeparateProjectRootUnchanged("project-1", sibling, state)).rejects.toThrow(
          "cannot be moved",
        ),
      );
      yield* Effect.promise(() => assertSeparateProjectRootUnchanged("project-1", root, state));
      const missingLauncher = yield* Effect.result(
        executionLauncherForCwd(root, { AGENT_EXEC_STATE: state }),
      );
      expect(missingLauncher._tag).toBe("Failure");
      expect(
        yield* executionLauncherForCwd(root, {
          AGENT_EXEC_STATE: state,
          T3CODE_EXECUTION_LAUNCHER: "/bin/agent-exec",
        }),
      ).toBe("/bin/agent-exec");
    }),
);
