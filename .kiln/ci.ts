import { Flake, Nix, Step, Task, cmd } from "@kiln/core";
import { Project } from "@kiln/std";
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

/** The update feed's manifest, which the OTA update and the TestFlight build agree on. */
const updatesUrl = "https://t3code-updates.schnau.dev/manifest";

/**
 * The desktop and iOS apps ship from every deployed commit. Packaging, signing and TestFlight run on
 * the Apple builder (m1) in Hauke's GUI session, where Xcode and the signing keychain work; the
 * update feed lives on srv-2. A desktop or mobile failure never holds up the deploy.
 */
const apps = (promote: Step.Any) => {
  const desktopPackage = Task.make("desktop-package", {
    platform: "aarch64-darwin",
    after: [promote],
    run: cmd`just ci-desktop-package`,
    outputs: { release: "desktop-release" },
  }).pipe(Step.timeout("60 minutes"));
  const desktopPublish = Task.make("desktop-publish", {
    shell,
    run: cmd`just ci-desktop-publish ${desktopPackage.outputs.release}`,
  }).pipe(Step.timeout("15 minutes"));
  const mobileUpdate = Task.make("mobile-update", {
    shell,
    after: [promote],
    run: cmd`just ci-mobile-update`,
    env: { T3CODE_MOBILE_UPDATES_URL: updatesUrl },
    outputs: { runtime: "mobile-runtime-version" },
  }).pipe(Step.timeout("30 minutes"));
  const testflight = Task.make("testflight", {
    platform: "aarch64-darwin",
    run: cmd`just ci-mobile-testflight ${mobileUpdate.outputs.runtime}`,
    env: { T3CODE_MOBILE_UPDATES_URL: updatesUrl },
  }).pipe(Step.timeout("120 minutes"));
  return [desktopPublish, testflight];
};

export default Project.standard({
  flake,
  checks: [...deps, lint, ...typecheck, testClients, testServer, smoke],
  afterDeploy: apps,
});
