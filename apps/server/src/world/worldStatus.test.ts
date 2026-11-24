import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decodeDaemonThreadStatus, toWorldThreadStatus } from "./worldStatus.ts";

describe("toWorldThreadStatus", () => {
  it.effect("maps the daemon's status to what the thread shows", () =>
    Effect.gen(function* () {
      // A response as native/worldfs/ctl.go writes it, Go's null slices included.
      const daemon = yield* decodeDaemonThreadStatus({
        ok: true,
        thread: "t3-0123456789abcdef0123",
        world: "buildlinx",
        path: "/home/haukeschnau/Buildlinx",
        checkedOut: 2,
        bytes: 1024,
        cap: { free: 20, perMinute: 10, maxRepos: 50, maxBytes: 10737418240 },
        repos: [
          {
            repo: "git.buildlinx.io/cloud/frontend",
            dir: "/home/haukeschnau/Buildlinx/Repos/cloud/frontend",
            state: "checked-out",
            version: "abc",
            following: false,
            head: "def",
            headOnRemote: false,
            dirty: 3,
            ignored: 1,
            commits: 1,
            jjCommits: 2,
            branches: [
              { name: "fix/live-lag", commits: 2 },
              { name: "merged", commits: 0 },
            ],
            lostOnTeardown: true,
          },
          {
            repo: "git.schnau.dev/schnau/t3code",
            dir: "/home/haukeschnau/Buildlinx/git.schnau.dev/schnau/t3code",
            state: "view",
            version: "abc",
            following: true,
            headOnRemote: true,
            dirty: 0,
            commits: 0,
            jjCommits: 0,
            branches: null,
            lostOnTeardown: false,
            error: "index unreadable",
          },
        ],
        refusals: [
          { at: "2026-11-24T08:00:00Z", repo: "a", process: "pnpm[7]", reason: "first" },
          {
            at: "2026-11-24T08:01:00Z",
            repo: "b",
            process: "node-MainThread[42]",
            reason: "second",
          },
        ],
      });
      expect(toWorldThreadStatus(daemon, 42)).toEqual({
        world: "buildlinx",
        path: "/home/haukeschnau/Buildlinx",
        available: true,
        repos: [
          {
            repo: "git.buildlinx.io/cloud/frontend",
            dir: "Repos/cloud/frontend",
            checkedOut: true,
            dirty: 3,
            commits: 3,
            branches: [{ name: "fix/live-lag", commits: 2 }],
            lostOnTeardown: true,
          },
          {
            repo: "git.schnau.dev/schnau/t3code",
            dir: "git.schnau.dev/schnau/t3code",
            checkedOut: false,
            dirty: 0,
            commits: 0,
            branches: [],
            lostOnTeardown: false,
            error: "index unreadable",
          },
        ],
        refusals: [
          { at: "2026-11-24T08:01:00Z", repo: "b", tool: "Claude's Bash hook", reason: "second" },
          { at: "2026-11-24T08:00:00Z", repo: "a", tool: "pnpm", reason: "first" },
        ],
      });
    }),
  );

  it.effect("reads a thread that touched nothing", () =>
    Effect.gen(function* () {
      const daemon = yield* decodeDaemonThreadStatus({
        ok: true,
        world: "schnau",
        path: "/home/haukeschnau/Schnau",
        repos: null,
        refusals: null,
      });
      expect(toWorldThreadStatus(daemon, 42)).toMatchObject({ repos: [], refusals: [] });
    }),
  );
});
