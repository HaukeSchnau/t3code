// @effect-diagnostics nodeBuiltinImport:off -- filesystem boundary integration fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  assertSeparateProjectDriver,
  executionLauncherForCwd,
  resolveSeparateProjectProvider,
  separateProjectPolicy,
} from "./ProjectExecution.ts";
import {
  isSeparateProject,
  assertSeparateProjectRootUnchanged,
} from "./SeparateProjectRegistry.ts";

const encodeRegistration = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Number,
      root: Schema.String,
      projectId: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.Struct({ visibleRoot: Schema.String })),
    }),
  ),
);

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
        yield* encodeRegistration({ version: 1, root, projectId: "project-1" }),
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

it.effect("launches registered providers on the host while they address the agent's view", () =>
  Effect.gen(function* () {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-project-provider-")),
    );
    roots.push(base);
    const root = NodePath.join(base, "project");
    const state = NodePath.join(base, "state");
    const cwd = NodePath.join(root, "src");
    for (const directory of [cwd, NodePath.join(state, "projects")])
      NodeFS.mkdirSync(directory, { recursive: true });
    const id = NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 20);
    NodeFS.writeFileSync(
      NodePath.join(state, "projects", `${id}.json`),
      yield* encodeRegistration({
        version: 1,
        root,
        workspace: { visibleRoot: "/home/agent/project" },
      }),
    );
    const environment = { AGENT_EXEC_STATE: state, T3CODE_EXECUTION_LAUNCHER: "/bin/agent-exec" };

    const project = yield* resolveSeparateProjectProvider(cwd, environment);
    expect(project).toMatchObject({
      launcher: "/bin/agent-exec",
      hostCwd: cwd,
      cwd: "/home/agent/project/src",
    });
    expect(project?.endpoint("http://127.0.0.1:4000/mcp")).toBe("http://10.0.2.2:4000/mcp");
    const policy = { runtimeMode: "full-access", cwd };
    expect(separateProjectPolicy(project, policy)).toEqual({
      ...policy,
      cwd: "/home/agent/project/src",
    });
    const unrelated = { cwd: base };
    expect(separateProjectPolicy(project, unrelated)).toBe(unrelated);
    expect(yield* resolveSeparateProjectProvider(base, environment)).toBeUndefined();
    expect(yield* resolveSeparateProjectProvider(null, environment)).toBeUndefined();
    const missingLauncher = yield* Effect.result(
      resolveSeparateProjectProvider(cwd, { AGENT_EXEC_STATE: state }),
    );
    expect(missingLauncher._tag).toBe("Failure");

    yield* assertSeparateProjectDriver("codex", cwd, environment);
    yield* assertSeparateProjectDriver("claudeAgent", cwd, environment);
    yield* assertSeparateProjectDriver("opencode", base, environment);
    const rejected = yield* Effect.flip(assertSeparateProjectDriver("opencode", cwd, environment));
    expect(rejected.reason.description).toContain("only supports Codex and Claude");
  }),
);
