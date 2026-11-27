import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  declaredWorldsFromConfigs,
  fileProjectsIntoWorlds,
  worldOfScopeKey,
  worldRepoName,
  worldScopeKey,
} from "./worlds.ts";

const identity = (canonicalKey: string, origin?: string): RepositoryIdentity =>
  ({
    canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: canonicalKey },
    ...(origin === undefined ? {} : { origin: { canonicalKey: origin, remoteUrl: origin } }),
  }) as RepositoryIdentity;

const project = (
  environmentId: string,
  id: string,
  workspaceRoot: string,
  extra: { world?: string; repositoryIdentity?: RepositoryIdentity; title?: string } = {},
) => ({
  environmentId,
  id,
  title: extra.title ?? id,
  workspaceRoot,
  world: extra.world ?? null,
  repositoryIdentity: extra.repositoryIdentity ?? null,
});

describe("fileProjectsIntoWorlds", () => {
  const projects = [
    project("srv-1", "bx", "/home/u/.t3/worlds/buildlinx", {
      world: "buildlinx",
      title: "BuildlinX World",
    }),
    project("tower", "bx", "/home/u/.t3/worlds/buildlinx", {
      world: "buildlinx",
      title: "BuildlinX World",
    }),
    project("srv-2", "sc", "/home/u/.t3/worlds/schnau", { world: "schnau", title: "Schnau World" }),
    // An umbrella with no remote, under the world's path.
    project("dev-hauke", "umbrella", "/home/u/Buildlinx"),
    project("dev-hauke", "frontend", "/home/u/Buildlinx/Repos/buildlinx/cloud/frontend", {
      repositoryIdentity: identity("git.buildlinx.io/buildlinx/cloud/frontend"),
    }),
    project("dev-hauke", "m2", "/home/u/m2", {
      repositoryIdentity: identity("git.buildlinx.io/m2/m2"),
    }),
    // Upstream is its canonical key; the fork's origin decides the namespace.
    project("srv-2", "t3code", "/home/u/Code/t3code", {
      repositoryIdentity: identity("github.com/pingdotgg/t3code", "git.schnau.dev/schnau/t3code"),
    }),
    project("srv-2", "hopwatch", "/home/u/Code/hopwatch", {
      repositoryIdentity: identity("github.com/HaukeSchnau/hopwatch"),
    }),
    project("srv-2", "shared", "/home/u/Code/both", {
      repositoryIdentity: identity("github.com/someone/both"),
    }),
    project("srv-2", "scratch", "/home/u/.t3/scratch"),
  ];
  // dev-hauke declares no worlds, so it files by the paths the other servers declare.
  const worlds = declaredWorldsFromConfigs(
    new Map([
      [
        "srv-1",
        {
          settings: {
            worlds: {
              buildlinx: { path: "/home/u/Buildlinx" },
              schnau: { path: "/home/u/Schnau" },
            },
          },
          worldNamespaces: {
            buildlinx: ["git.buildlinx.io/buildlinx", "git.buildlinx.io/m2", "github.com/someone"],
            schnau: ["git.schnau.dev/schnau", "github.com/haukeschnau"],
          },
        },
      ],
      // A namespace two worlds' catalogs hold files nothing.
      ["srv-2", { settings: { worlds: {} }, worldNamespaces: { schnau: ["github.com/someone"] } }],
      ["dev-hauke", { settings: { worlds: {} } }],
    ]),
  );
  const filing = fileProjectsIntoWorlds({ projects, worlds });

  it("lists each world once, titled by its project, across machines", () => {
    expect(filing.worlds).toEqual([
      { id: "buildlinx", title: "BuildlinX World" },
      { id: "schnau", title: "Schnau World" },
    ]);
  });

  it("files older projects by the world's path or by a namespace only that world's catalog holds", () => {
    expect(Object.fromEntries(filing.worldByProjectKey)).toEqual({
      "srv-1:bx": "buildlinx",
      "tower:bx": "buildlinx",
      "srv-2:sc": "schnau",
      "dev-hauke:umbrella": "buildlinx",
      "dev-hauke:frontend": "buildlinx",
      "dev-hauke:m2": "buildlinx",
      "srv-2:t3code": "schnau",
      "srv-2:hopwatch": "schnau",
    });
  });

  it("files by the paths a project's own server declares, if it declares any", () => {
    const paths = declaredWorldsFromConfigs(
      new Map([
        ["srv-1", { settings: { worlds: { buildlinx: { path: "/home/u/Buildlinx" } } } }],
        ["srv-3", { settings: { worlds: { buildlinx: { path: "/srv/Buildlinx" } } } }],
        ["srv-4", { settings: { worlds: { schnau: { path: "/home/u/Schnau" } } } }],
      ]),
    );
    const filed = fileProjectsIntoWorlds({
      projects: [
        projects[0]!,
        projects[2]!,
        project("srv-3", "umbrella", "/srv/Buildlinx"),
        project("srv-3", "home", "/home/u/Buildlinx"),
        project("srv-4", "home", "/home/u/Buildlinx"),
      ],
      worlds: paths,
    });
    expect(filed.worldByProjectKey.get("srv-3:umbrella")).toBe("buildlinx");
    expect(filed.worldByProjectKey.has("srv-3:home")).toBe(false);
    expect(filed.worldByProjectKey.has("srv-4:home")).toBe(false);
  });

  it("files nothing by a namespace another world's catalog also holds, even without its project", () => {
    const filed = fileProjectsIntoWorlds({
      projects: [projects[0]!, projects[5]!],
      worlds: declaredWorldsFromConfigs(
        new Map([
          [
            "srv-1",
            {
              worldNamespaces: {
                buildlinx: ["git.buildlinx.io/m2"],
                schnau: ["git.buildlinx.io/m2"],
              },
            },
          ],
        ]),
      ),
    });
    expect(filed.worldByProjectKey.has("dev-hauke:m2")).toBe(false);
  });

  it("files a project under the innermost of nested world paths, whatever the project order", () => {
    const nested = declaredWorldsFromConfigs(
      new Map([
        [
          "srv-1",
          {
            settings: {
              worlds: { schnau: { path: "/home/u" }, buildlinx: { path: "/home/u/Buildlinx" } },
            },
          },
        ],
      ]),
    );
    const umbrella = project("srv-1", "app", "/home/u/Buildlinx/app");
    for (const order of [
      [projects[0]!, projects[2]!, umbrella],
      [projects[2]!, projects[0]!, umbrella],
    ]) {
      const filed = fileProjectsIntoWorlds({ projects: order, worlds: nested });
      expect(filed.worldByProjectKey.get("srv-1:app")).toBe("buildlinx");
    }
  });

  it("files nothing without a world project", () => {
    expect(fileProjectsIntoWorlds({ projects: projects.slice(3), worlds })).toEqual({
      worlds: [],
      worldByProjectKey: new Map(),
    });
  });
});

describe("worldRepoName", () => {
  it("names a repo by its directory, and the world's root by its repo", () => {
    expect(worldRepoName({ dir: "Repos/buildlinx/cloud/frontend", repo: "x" })).toBe("frontend");
    expect(worldRepoName({ dir: ".", repo: "git.schnau.dev/schnau/world" })).toBe("world");
  });
});

describe("world scope keys", () => {
  it("round-trips a world and the outside of every world, and ignores project keys", () => {
    expect(worldOfScopeKey(worldScopeKey("buildlinx"))).toBe("buildlinx");
    expect(worldOfScopeKey(worldScopeKey(null))).toBeNull();
    expect(worldOfScopeKey("git.schnau.dev/schnau/t3code")).toBeUndefined();
  });
});
