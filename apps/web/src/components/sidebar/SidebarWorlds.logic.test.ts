import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  fileProjectsIntoWorlds,
  declaredWorldsFromConfigs,
  worldScopeKey,
} from "@t3tools/client-runtime/state/worlds";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import {
  buildWorldLenses,
  expandWorldScopeKeys,
  narrowToWorldLens,
  worldLensNewThreadProjectRef,
} from "./SidebarWorlds.logic";

const tower = EnvironmentId.make("tower");
const srv2 = EnvironmentId.make("srv-2");

function makeProject(
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot: string,
  overrides: Partial<Project> = {},
): Project {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey: "github.com/owner/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/owner/repo.git",
      },
    },
    defaultModelSelection: null,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("world lenses", () => {
  // One repository, cloned inside the BuildlinX world's path on tower and outside it on srv-2.
  const projects = [
    makeProject(tower, "world", "/home/u/.t3/worlds/buildlinx", {
      title: "BuildlinX World",
      world: "buildlinx",
      repositoryIdentity: null,
    }),
    makeProject(tower, "filed", "/home/u/Buildlinx/Repos/repo"),
    makeProject(srv2, "loose", "/home/u/Code/repo"),
  ];
  const groups = buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: tower,
    resolveEnvironmentLabel: (id) => id,
  });
  const filing = fileProjectsIntoWorlds({
    projects,
    worlds: declaredWorldsFromConfigs(
      new Map([["tower", { settings: { worlds: { buildlinx: { path: "/home/u/Buildlinx" } } } }]]),
    ),
  });
  const allProjectKeys = new Set(
    projects.map((project) => `${project.environmentId}:${project.id}`),
  );

  it("scopes each lens to the clones filed under it", () => {
    const outside = worldScopeKey(null);
    expect(expandWorldScopeKeys([outside], filing, groups)).toHaveLength(1);
    expect(narrowToWorldLens(allProjectKeys, outside, filing)).toEqual(new Set(["srv-2:loose"]));
    expect(narrowToWorldLens(allProjectKeys, worldScopeKey("buildlinx"), filing)).toEqual(
      new Set(["tower:world", "tower:filed"]),
    );
  });

  it("starts a new thread under a world lens in the world's own open project, or the picker", () => {
    const newThreadRef = (lensKey: string | null) =>
      worldLensNewThreadProjectRef({ lensKey, groups, primaryEnvironmentId: srv2 });
    expect(newThreadRef(worldScopeKey("buildlinx"))).toEqual({
      environmentId: tower,
      projectId: "world",
    });
    expect(newThreadRef(worldScopeKey(null))).toBeUndefined();
    expect(newThreadRef(null)).toBeUndefined();
    const archived = buildSidebarProjectSnapshots({
      projects: projects.map((project) =>
        project.world ? { ...project, archivedAt: "2026-07-02T00:00:00.000Z" } : project,
      ),
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      primaryEnvironmentId: tower,
      resolveEnvironmentLabel: (id) => id,
    });
    expect(
      worldLensNewThreadProjectRef({
        lensKey: worldScopeKey("buildlinx"),
        groups: archived,
        primaryEnvironmentId: tower,
      }),
    ).toBeNull();
  });

  it("counts a clone outside every world under the outside lens", () => {
    const lenses = buildWorldLenses({
      filing,
      groups,
      needsYou: [{ environmentId: srv2, projectId: ProjectId.make("loose") }],
    });
    expect(lenses.outsideNeedsYou).toBe(1);
    expect(lenses.worlds.map((world) => [world.id, world.needsYou])).toEqual([["buildlinx", 0]]);
  });
});
