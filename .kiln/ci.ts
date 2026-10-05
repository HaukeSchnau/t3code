import { Action, CurrentRun, Flake, Gitea, Kiln, Nix, On, Step, Task, cmd } from "@kiln/core";
import { Release } from "@kiln/std";
import { Effect } from "effect";
import { flake } from "./flake.ts";

const shell = flake.devShells.ci;

/** The filtered pnpm stores the release builds from; a stale hash fails here first. */
export const deps = ["web", "server", "runtime"].map((part) =>
  Nix.build(Flake.select(flake.packages.t3code, `pnpmDeps.${part}`), { name: `deps-${part}` }),
);

export const lint = Task.make("static", { shell, run: cmd`just qa-static` }).pipe(
  Step.timeout("15 minutes"),
);

// Native TypeScript is written in Go; collect before the worker reaches MemoryHigh.
export const typecheck = ["clients", "rest"].map((group) =>
  Task.make(`typecheck-${group}`, {
    shell,
    run: cmd`just qa-typecheck-${group}`,
    env: { GOMEMLIMIT: "3GiB" },
  }).pipe(Step.timeout("15 minutes")),
);

export const testClients = Task.make("test-clients", {
  shell,
  run: cmd`just qa-test-non-server`,
}).pipe(Step.timeout("35 minutes"));

export const testServer = Task.make("test-server", {
  shell,
  shards: { count: 6 },
  run: ({ index, count }) => cmd`just qa-test-server-shard ${index} ${count}`,
}).pipe(Step.timeout("30 minutes"));

export const smoke = Task.make("release-smoke", { shell, run: cmd`just qa-release` }).pipe(
  Step.timeout("10 minutes"),
);

export const gate = Nix.build(flake.checks.projectReleaseGate, { name: "gate" });
export const release = Nix.build(flake.packages.projectRelease, { name: "release" });

export const checks = [...deps, lint, ...typecheck, testClients, testServer, smoke, gate];

export const promote = Action.make(
  "promote",
  { needs: { release }, after: checks, grants: { deploy: true } },
  function* ({ release }) {
    return yield* Release.promote(release);
  },
);

/**
 * The desktop and iOS apps build on the Apple builder, which still runs Gitea Actions. Their build
 * number only grows, so it is the dispatch time rather than a run number.
 */
export const apple = Action.make("apple", { after: [promote] }, function* () {
  const run = yield* CurrentRun;
  const build = String(
    Math.floor((yield* Effect.clockWith((clock) => clock.currentTimeMillis)) / 1000),
  );
  yield* Gitea.dispatch("desktop.yml", {
    ref: "main",
    inputs: { sha: run.revision, build_number: build },
  });
  yield* Gitea.dispatch("mobile.yml", { ref: "main", inputs: { sha: run.revision } });
});

export default Kiln.project({
  rules: [On.pullRequest([...checks, release]), On.push("main", [promote, apple])],
});
