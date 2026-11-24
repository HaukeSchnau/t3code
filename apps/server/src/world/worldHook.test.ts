import { describe, expect, it } from "@effect/vitest";

import { commandDirectories, hookDecision, worldDirectories } from "./worldHook.ts";

const HOME = "/home/haukeschnau";
const WORLD = "/home/haukeschnau/Buildlinx";

const inWorld = (command: string, cwd = WORLD) =>
  worldDirectories(commandDirectories(command, cwd, HOME), WORLD);

describe("world hook directories", () => {
  it.each([
    ["cd Repos/igs-site && pnpm install", [`${WORLD}/Repos/igs-site`]],
    ["cd ~/Buildlinx/Repos/a; cd ../b && make", [`${WORLD}/Repos/a`, `${WORLD}/Repos/b`]],
    ['pushd "Repos/with space" >/dev/null', [`${WORLD}/Repos/with space`]],
    ["if true; then cd Repos/a; fi", [`${WORLD}/Repos/a`]],
    ["for d in x; do cd Repos/c; done", [`${WORLD}/Repos/c`]],
    ["cd Repos/a || cd Repos/b", [`${WORLD}/Repos/a`]],
    ["cd Repos/a; false || cd Repos/b", [`${WORLD}/Repos/a`]],
    ["(cd Repos/a && make) && cd Repos/b", []],
    ['echo "a\\" ; cd Repos/x" && ls', []],
    ['printf \'%s\\n\' "$(printf "x; cd Repos/a; ")"', []],
    ["echo $(cd Repos/a && pwd)", []],
    ['printf "%s" "$\\\n(printf "x; cd Repos/a; ")"', []],
    ['cd "Repos/a\\b"', [`${WORLD}/Repos/a\\b`]],
    ["printf '%s\\n' 'example; cd Repos/full && make'", []],
    ['echo "cd Repos/x" && ls', []],
    ["cd /tmp && ls", []],
    ["cd - && cd && cd $REPO && ls", []],
    ["git -C Repos/a log", []],
  ])("%s", (command, expected) => {
    expect(inWorld(command)).toEqual(expected);
  });

  it("includes the session's cwd when it is inside a repo", () => {
    expect(inWorld("pnpm test", `${WORLD}/Repos/a/src`)).toEqual([`${WORLD}/Repos/a/src`]);
  });

  it("leaves out the world's top and anything outside it", () => {
    expect(worldDirectories([WORLD, "/home/haukeschnau/Buildlinx2/x", "/tmp"], WORLD)).toEqual([]);
  });
});

describe("hookDecision", () => {
  it("lets the command run when every checkout succeeded or the path is in no repo", () => {
    expect(
      hookDecision([
        { ok: true },
        { ok: false, code: "outside", message: "in the world but in no repo" },
      ]),
    ).toBeUndefined();
  });

  it("lets the command run when the daemon is down, leaving the check-out on cd to the daemon", () => {
    expect(hookDecision([{ ok: false, code: "unavailable", message: "not running" }])).toBe(
      undefined,
    );
  });

  it("turns refusals into one readable denial", () => {
    const denial = hookDecision([
      { ok: true },
      {
        ok: false,
        code: "cap",
        message: "refused usageguard: 2 repos already checked out in this thread, the cap is 2",
      },
      { ok: false, code: "missing-objects", message: "genesis is missing objects" },
    ]);
    expect(denial?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denial?.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^World checkout refused, so this command would run on the read-only view: refused usageguard: 2 repos already checked out in this thread, the cap is 2; genesis is missing objects\. /,
    );
  });
});
