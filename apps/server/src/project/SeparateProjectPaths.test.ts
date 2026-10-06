// @effect-diagnostics nodeBuiltinImport:off -- exercises the host namespace registry with real temporary files.
import { it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { projectHostPath, projectProviderView } from "./SeparateProjectRegistry.ts";

const publicationFixture = vi.hoisted(() => ({ root: "" }));

// The CI account cannot traverse the real publication directory. Keep realpath's
// symlink checks, but route the public mount to this test's temporary directory.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => {
      const [path, options] = args;
      const prefix = "/srv/agent-share/";
      const target =
        publicationFixture.root && typeof path === "string" && path.startsWith(prefix)
          ? `${publicationFixture.root}/${path.slice(prefix.length)}`
          : path;
      return actual.realpath(target, options);
    },
  };
});

it("resolves identical project and scratch paths by workspace, including legacy image paths", async () => {
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "isolated-paths-"));
  const base = await NodeFSP.realpath(temporary);
  const state = NodePath.join(base, "state");
  publicationFixture.root = NodePath.join(base, "published");
  try {
    await NodeFSP.mkdir(NodePath.join(state, "projects"), { recursive: true });
    const roots = [NodePath.join(base, "a"), NodePath.join(base, "b")];
    const visibleHome = "/home/setup-test-user";
    const visibleRoot = NodePath.join(visibleHome, "project");
    for (const [index, root] of roots.entries()) {
      await NodeFSP.mkdir(root);
      const id = NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 20);
      await NodeFSP.writeFile(
        NodePath.join(state, "projects", `${id}.json`),
        JSON.stringify({
          root,
          home: visibleHome,
          workspace: { visibleRoot },
        }),
      );
      const published = `/srv/agent-share/isolated/${id}/image.png`;
      const actualPublished = NodePath.join(publicationFixture.root, "isolated", id, "image.png");
      await NodeFSP.mkdir(NodePath.dirname(actualPublished), { recursive: true });
      await NodeFSP.writeFile(actualPublished, `published-${index}`);
      NodeAssert.equal(await projectHostPath(root, published, state), actualPublished);
      NodeAssert.equal(
        await projectHostPath(root, "/srv/agent-share/image.png", state),
        actualPublished,
      );
      const aliasImage = NodePath.join(NodePath.dirname(actualPublished), "alias.png");
      await NodeFSP.symlink("image.png", aliasImage);
      NodeAssert.equal(
        await projectHostPath(root, `/srv/agent-share/isolated/${id}/alias.png`, state),
        actualPublished,
      );
      await NodeAssert.rejects(
        projectHostPath(root, "/srv/agent-share/isolated/another-workspace/image.png", state),
      );
      await NodeAssert.rejects(
        projectHostPath(
          root,
          `/srv/agent-share/isolated/${id}/../another-workspace/image.png`,
          state,
        ),
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
        (await projectProviderView(NodePath.join(root, "src"), state))?.cwd,
        NodePath.join(visibleRoot, "src"),
      );
      NodeAssert.equal(
        (await projectProviderView(root, state))?.endpoint("http://127.0.0.1:4000/mcp"),
        "http://10.0.2.2:4000/mcp",
      );
      const alias = NodePath.join(base, `alias-${index}`);
      await NodeFSP.symlink(root, alias);
      NodeAssert.equal((await projectProviderView(alias, state))?.cwd, visibleRoot);
      const hostHomeFile = NodePath.join(state, "environments", id, "home", ".cache", "probe");
      await NodeFSP.mkdir(NodePath.dirname(hostHomeFile), { recursive: true });
      await NodeFSP.writeFile(hostHomeFile, `home-${index}`);
      NodeAssert.equal(
        await NodeFSP.readFile(
          await projectHostPath(root, NodePath.join(visibleHome, ".cache", "probe"), state),
          "utf8",
        ),
        `home-${index}`,
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
    const legacy = await projectProviderView(first, state);
    NodeAssert.equal(legacy?.cwd, first);
    NodeAssert.equal(legacy?.endpoint("http://localhost:4000/mcp"), "http://localhost:4000/mcp");
    NodeAssert.equal(await projectProviderView(base, state), undefined);
    NodeAssert.equal(await projectHostPath(base, "/tmp/host.png", state), "/tmp/host.png");
  } finally {
    publicationFixture.root = "";
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});
