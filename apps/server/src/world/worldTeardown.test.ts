import type { WorldThreadRepo, WorldThreadStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { teardownDecision, WORLD_QUIET_MS } from "./worldTeardown.ts";

const NOW = 1_800_000_000_000;
const LONG_AGO = NOW - WORLD_QUIET_MS - 1;

const repo = (overrides: Partial<WorldThreadRepo> = {}): WorldThreadRepo => ({
  repo: "git.buildlinx.io/cloud/frontend",
  dir: "Repos/cloud/frontend",
  checkedOut: true,
  dirty: 0,
  commits: 0,
  branches: [],
  lostOnTeardown: false,
  ...overrides,
});

const status = (repos: ReadonlyArray<WorldThreadRepo>): WorldThreadStatus => ({
  world: "buildlinx",
  path: "/home/haukeschnau/Buildlinx",
  available: true,
  repos,
  refusals: [],
});

const decide = (overrides: Partial<Parameters<typeof teardownDecision>[0]> = {}) =>
  teardownDecision({
    nowMs: NOW,
    createdMs: LONG_AGO,
    threads: [{ active: false, lastActivityMs: LONG_AGO }],
    status: status([repo()]),
    looseFiles: [],
    ...overrides,
  });

describe("teardownDecision", () => {
  it("tears down a quiet settled thread world whose work every remote has", () => {
    expect(decide()).toEqual({ teardown: true });
  });

  it("tears down the world of a deleted thread once it is quiet", () => {
    expect(decide({ threads: [] })).toEqual({ teardown: true });
  });

  it("keeps a world any thread still uses", () => {
    expect(
      decide({
        threads: [
          { active: false, lastActivityMs: LONG_AGO },
          { active: true, lastActivityMs: LONG_AGO },
        ],
      }),
    ).toMatchObject({ teardown: false });
  });

  it("keeps a world whose thread settled less than 6 hours ago, so its session can still resume", () => {
    expect(
      decide({ threads: [{ active: false, lastActivityMs: NOW - WORLD_QUIET_MS + 1 }] }),
    ).toMatchObject({ teardown: false });
  });

  it("keeps a just-created world no thread names yet", () => {
    expect(decide({ threads: [], createdMs: NOW - 60_000 })).toMatchObject({ teardown: false });
  });

  it.each([
    ["dirty files", repo({ dirty: 2, lostOnTeardown: true })],
    ["commits only the thread has", repo({ commits: 1, lostOnTeardown: true })],
    ["an unreadable repo", repo({ error: "git status failed", lostOnTeardown: true })],
  ])("keeps a world with %s", (_, held) => {
    expect(decide({ status: status([repo({ repo: "a" }), held]) })).toEqual({
      teardown: false,
      reason: `work no remote has in ${held.repo}`,
    });
  });

  it("tears down when only shared mirror branches are unpushed, since they outlive the world", () => {
    expect(
      decide({ status: status([repo({ branches: [{ name: "fix/x", commits: 3 }] })]) }),
    ).toEqual({ teardown: true });
  });

  it("keeps a world while the daemon can't be asked", () => {
    expect(decide({ status: undefined })).toMatchObject({ teardown: false });
    expect(
      decide({ status: { ...status([]), available: false, message: "not running" } }),
    ).toMatchObject({ teardown: false });
  });

  it("keeps a world with files outside its repos", () => {
    expect(decide({ looseFiles: ["notes.md"] })).toEqual({
      teardown: false,
      reason: "files outside the world's repos: notes.md",
    });
  });
});
