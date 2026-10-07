import { Files, Flake, Nix, Report, Step, Task, cmd } from "@kiln/core";
import { Pnpm, Project } from "@kiln/std";
import { flake } from "./flake.ts";

const shell = flake.devShells.ci;

/**
 * The committed lockfile as is, like the Nix release build; rechecking every locked version against
 * the registry stalled cold installs. Builds and caches of the apps survive between tasks.
 */
const install = Pnpm.install({
  shell,
  args: ["--trust-lockfile"],
  keep: [".repos", ".t3", "release", ".expo", "dist", "dist-electron", "build"],
});

/** The filtered pnpm stores the release builds from; a stale hash fails here first. */
export const deps = ["web", "server", "runtime"].map((part) =>
  Nix.build(Flake.select(flake.packages.t3code, `pnpmDeps.${part}`), { name: `deps-${part}` }),
);

export const lint = Task.make("static", { shell, setup: install, run: cmd`just qa-static` }).pipe(
  Step.timeout("15 minutes"),
);

/** What every test and typecheck shares: the dependencies and the base tsconfig. */
const dependencies = Files.of(
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
);

/** The import aliases of the root Vitest config and the web app's tsconfig. */
const aliases = {
  "~": "apps/web/src",
  "expo-crypto": "apps/mobile/src/test-support/expo-crypto.ts",
};

/** The root Vitest config's setup file, which most packages' suites run with. */
const longTempDir = "packages/shared/src/testing/longTempDir.ts";

/**
 * A package's Vitest suite, file by file: a test file runs again only when it, what it imports or its
 * package's other files changed. `config` is what every file runs with besides the dependencies:
 * Vitest configs and setup files. The root config is listed as a file, since following its imports
 * would pull in all of apps/web/src through the `~` alias.
 */
const vitest = (options: {
  readonly name: string;
  readonly dir: string;
  readonly tests: ReadonlyArray<string>;
  readonly config: Files.Files;
  readonly shards?: number;
  readonly recipe?: "qa-test-server" | "qa-test-desktop";
}) =>
  Task.make(options.name, {
    shell,
    setup: install,
    each: Files.imports(
      options.tests.map((test) => `${options.dir}/${test}`),
      { aliases },
    ),
    inputs: Files.union(dependencies, options.config),
    shards: { count: options.shards ?? 1 },
    run: ({ files }) =>
      options.recipe === undefined
        ? cmd`just qa-test-package ${options.dir} ${files}`
        : cmd`just ${options.recipe} ${files}`,
    report: Report.vitest(`${options.dir}/.vitest-report.json`),
  });

export const testServer = vitest({
  name: "test-server",
  dir: "apps/server",
  tests: ["**/*.test.ts"],
  config: Files.union(
    Files.of("vitest.config.ts", "apps/server/vitest.config.ts"),
    Files.imports([
      longTempDir,
      "apps/server/src/testUtils/gitConfig.setup.ts",
      "apps/server/src/testUtils/weightedShardSequencer.ts",
    ]),
  ),
  shards: 6,
  recipe: "qa-test-server",
}).pipe(Step.timeout("45 minutes"));

export const testWeb = vitest({
  name: "test-web",
  dir: "apps/web",
  tests: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  config: Files.imports("apps/web/vitest.config.ts"),
  shards: 2,
}).pipe(Step.timeout("30 minutes"));

export const testMobile = vitest({
  name: "test-mobile",
  dir: "apps/mobile",
  tests: ["**/*.test.ts", "**/*.test.tsx"],
  config: Files.union(
    Files.of("vitest.config.ts"),
    Files.imports([longTempDir, aliases["expo-crypto"]]),
  ),
}).pipe(Step.timeout("20 minutes"));

export const testDesktop = vitest({
  name: "test-desktop",
  dir: "apps/desktop",
  tests: ["**/*.test.ts", "**/*.test.js", "**/*.test.mjs"],
  config: Files.imports(["apps/desktop/vite.config.ts", longTempDir]),
  recipe: "qa-test-desktop",
}).pipe(Step.timeout("20 minutes"));

export const testClientRuntime = vitest({
  name: "test-client-runtime",
  dir: "packages/client-runtime",
  tests: ["src/**/*.test.ts"],
  config: Files.imports(["packages/client-runtime/vite.config.ts", longTempDir]),
}).pipe(Step.timeout("20 minutes"));

export const testShared = vitest({
  name: "test-shared",
  dir: "packages/shared",
  tests: ["src/**/*.test.ts"],
  config: Files.union(Files.of("vitest.config.ts"), Files.imports(longTempDir)),
}).pipe(Step.timeout("20 minutes"));

/** Packages with small suites run whole when they or anything their tests import changed. */
const smallSuites = [
  "packages/contracts",
  "packages/effect-acp",
  "packages/effect-codex-app-server",
  "packages/ssh",
  "packages/tailscale",
  "infra/relay",
  "oxlint-plugin-t3code",
];

export const testPackages = Task.make("test-packages", {
  shell,
  setup: install,
  inputs: Files.union(
    dependencies,
    Files.of("vitest.config.ts", ...smallSuites),
    Files.imports([...smallSuites.map((dir) => `${dir}/**/*.test.ts`), longTempDir], { aliases }),
  ),
  run: cmd`just qa-test-packages ${smallSuites}`,
}).pipe(Step.timeout("20 minutes"));

/** The repository scripts' tests read manifests, lockfiles and configs all over the repository. */
export const testScripts = Task.make("test-scripts", {
  shell,
  setup: install,
  run: cmd`just qa-test-packages scripts`,
}).pipe(Step.timeout("15 minutes"));

/**
 * Typechecks of package groups, each when its packages' tsconfigs or what their sources import,
 * types included, changed. `sources` are what the tsconfigs include. The server checks alone: tsgo
 * needs about 4 GB for it.
 */
const typecheck = (name: string, dirs: ReadonlyArray<string>, sources: ReadonlyArray<string>) =>
  Task.make(`typecheck-${name}`, {
    shell,
    setup: install,
    inputs: Files.union(
      dependencies,
      Files.of(...dirs.flatMap((dir) => [`${dir}/package.json`, `${dir}/tsconfig.json`])),
      Files.imports(sources, { aliases, types: true }),
    ),
    run: cmd`just qa-typecheck ${dirs}`,
    // Native TypeScript is written in Go; collect before the worker reaches MemoryHigh.
    env: { GOMEMLIMIT: "3GiB" },
  }).pipe(Step.timeout("15 minutes"));

export const typechecks = [
  typecheck(
    "server",
    ["apps/server"],
    [
      "apps/server/src/**/*.ts",
      "apps/server/scripts/**/*.ts",
      "apps/server/integration/**/*.ts",
      "apps/server/vite.config.ts",
      "scripts/lib/**/*.ts",
    ],
  ),
  typecheck(
    "web",
    ["apps/web"],
    [
      "apps/web/src/**/*.ts",
      "apps/web/src/**/*.tsx",
      "apps/web/vite/**/*.ts",
      "apps/web/test/**/*.ts",
      "apps/web/test/**/*.tsx",
      "apps/web/vite.config.ts",
      "apps/web/vercel.ts",
      "scripts/lib/public-config.ts",
      "scripts/lib/third-party-licenses.ts",
    ],
  ),
  typecheck("mobile", ["apps/mobile"], ["apps/mobile/**/*.ts", "apps/mobile/**/*.tsx"]),
  typecheck(
    "desktop",
    ["apps/desktop"],
    ["apps/desktop/src/**/*.ts", "apps/desktop/vite.config.ts", "scripts/lib/**/*.ts"],
  ),
  typecheck(
    "packages",
    [
      "packages/client-runtime",
      "packages/contracts",
      "packages/shared",
      "packages/effect-acp",
      "packages/effect-codex-app-server",
      "packages/ssh",
      "packages/tailscale",
    ],
    ["packages/*/src/**/*.ts", "packages/*/scripts/**/*.ts", "packages/*/test/**/*.ts"],
  ),
  // Astro checks .astro files, whose imports aren't followed, so marketing counts as a whole.
  typecheck(
    "tools",
    ["infra/relay", "scripts", "oxlint-plugin-t3code", "apps/marketing"],
    [
      "infra/relay/**/*.ts",
      "scripts/**/*.ts",
      "oxlint-plugin-t3code/**/*.ts",
      "apps/marketing/**/*",
    ],
  ),
];

/** The release smoke resolves the dependency graph from the manifests, lockfiles and patches. */
export const smoke = Task.make("release-smoke", {
  shell,
  setup: install,
  inputs: Files.union(
    Files.glob(
      "package.json",
      "apps/*/package.json",
      "apps/mobile/modules/*/package.json",
      "packages/*/package.json",
      "infra/*/package.json",
      "scripts/package.json",
      "oxlint-plugin-t3code/package.json",
      "patches/**/*.patch",
    ),
    Files.of(
      "pnpm-lock.yaml",
      "pnpm-deploy-lock.yaml",
      "pnpm-workspace.yaml",
      "vite.config.ts",
      ".github/scripts",
    ),
    Files.imports([
      "scripts/release-smoke.ts",
      "scripts/fork-lockfile.ts",
      "scripts/sync-pnpm-deploy-lock.mjs",
    ]),
  ),
  run: cmd`just qa-release`,
}).pipe(Step.timeout("10 minutes"));

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
    setup: install,
    run: cmd`just ci-desktop-publish ${desktopPackage.outputs.release}`,
  }).pipe(Step.timeout("15 minutes"));
  const mobileUpdate = Task.make("mobile-update", {
    shell,
    setup: install,
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
  checks: [
    ...deps,
    lint,
    ...typechecks,
    testServer,
    testWeb,
    testMobile,
    testDesktop,
    testClientRuntime,
    testShared,
    testPackages,
    testScripts,
    smoke,
  ],
  afterDeploy: apps,
  // Runs every check from scratch, which also shows whether a test file's key misses something it reads.
  nightly: "0 3 * * *",
});
