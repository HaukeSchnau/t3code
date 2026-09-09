// @effect-diagnostics nodeBuiltinImport:off -- exercises the host namespace registry with real temporary files.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  projectHostPath,
  projectProviderCwd,
  projectProviderEndpoint,
} from "./SeparateProjectRegistry.ts";

it("resolves identical project and scratch paths by workspace, including legacy image paths", async () => {
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "isolated-paths-"));
  const base = await NodeFSP.realpath(temporary);
  const state = NodePath.join(base, "state");
  try {
    await NodeFSP.mkdir(NodePath.join(state, "projects"), { recursive: true });
    const roots = [NodePath.join(base, "a"), NodePath.join(base, "b")];
    const visibleRoot = NodePath.join(base, "home", "project");
    for (const [index, root] of roots.entries()) {
      await NodeFSP.mkdir(root);
      const id = NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 20);
      await NodeFSP.writeFile(
        NodePath.join(state, "projects", `${id}.json`),
        JSON.stringify({
          root,
          home: NodePath.join(base, "home"),
          workspace: { visibleRoot },
        }),
      );
      const scratch = NodePath.join(state, "environments", id, "tmp");
      await NodeFSP.mkdir(scratch, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, "image.png"), `project-${index}`);
      await NodeFSP.writeFile(NodePath.join(scratch, "image.png"), `scratch-${index}`);
      NodeAssert.equal(
        await NodeFSP.readFile(
          await projectHostPath(root, NodePath.join(visibleRoot, "image.png"), state),
          "utf8",
        ),
        `project-${index}`,
      );
      NodeAssert.equal(
        await NodeFSP.readFile(await projectHostPath(root, "/tmp/image.png", state), "utf8"),
        `scratch-${index}`,
      );
      NodeAssert.equal(
        await projectProviderCwd(NodePath.join(root, "src"), state),
        NodePath.join(visibleRoot, "src"),
      );
      NodeAssert.equal(
        await projectProviderEndpoint(root, "http://127.0.0.1:4000/mcp", state),
        "http://10.0.2.2:4000/mcp",
      );
      await NodeAssert.rejects(projectHostPath(root, "/etc/unmapped.png", state));
    }
    const first = roots[0]!;
    await NodeFSP.symlink(roots[1]!, NodePath.join(first, "sibling"));
    await NodeAssert.rejects(
      projectHostPath(first, NodePath.join(visibleRoot, "sibling/image.png"), state),
    );
    const legacyId = NodeCrypto.createHash("sha256").update(first).digest("hex").slice(0, 20);
    await NodeFSP.writeFile(
      NodePath.join(state, "projects", `${legacyId}.json`),
      JSON.stringify({ root: first }),
    );
    NodeAssert.equal(
      await NodeFSP.readFile(await projectHostPath(first, "/tmp/image.png", state), "utf8"),
      "scratch-0",
    );
    NodeAssert.equal(await projectProviderCwd(first, state), first);
    NodeAssert.equal(
      await projectProviderEndpoint(first, "http://localhost:4000/mcp", state),
      "http://localhost:4000/mcp",
    );
    NodeAssert.equal(await projectHostPath(base, "/tmp/host.png", state), "/tmp/host.png");
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});
