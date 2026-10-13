import { Files, Flake, Nix, Setup, Step, Task, cmd } from "@kiln/core";
import { Pnpm, Project, Vitest } from "@kiln/std";
import { flake } from "./flake.ts";

const shell = flake.devShells.ci;

/**
 * The committed lockfile as is, like the Nix release build; rechecking every locked version against
 * the registry stalled cold installs.
 */
const install = Pnpm.install({ shell, args: ["--trust-lockfile"] });

/** The filtered pnpm stores the release builds from; a stale hash fails here first. */
const deps = ["web", "server", "runtime"].map((part) =>
  Nix.build(Flake.select(flake.packages.t3code, `pnpmDeps.${part}`), { name: `deps-${part}` }),
);

const check = Task.make("static", { shell, setup: install, run: cmd`vp check` }).pipe(
  Step.timeout("30 minutes"),
);

/** The import aliases of the root Vitest config and the web app's tsconfig. */
const aliases = {
  "~": "apps/web/src",
  "expo-crypto": "apps/mobile/src/test-support/expo-crypto.ts",
};

/** The root Vitest config's setup file, which most packages' suites run with. */
const longTempDir = "packages/shared/src/testing/longTempDir.ts";

/** Suites besides the server's leave room for the tasks running beside them. */
const workers = ["--maxWorkers", "3"];

/**
 * A package's Vitest suite runs file by file: a test file runs again only when it, what it imports
 * or the suite's `inputs` changed. `inputs` are Vitest configs and setup files. The root config is
 * listed as a file, since following its imports would pull in all of apps/web/src through the `~`
 * alias. `args` repeat the flags of the package's test script.
 */
const suite = { shell, setup: install, vitest: ["vp", "test"], aliases };

const testServer = Vitest.files({
  ...suite,
  name: "test-server",
  dir: "apps/server",
  tests: ["**/*.test.ts"],
  inputs: Files.union(
    Files.of("vitest.config.ts", "apps/server/vitest.config.ts"),
    Files.imports([
      longTempDir,
      "packages/shared/src/testing/isolatedTestFiles.ts",
      "apps/server/src/testUtils/gitConfig.setup.ts",
      "apps/server/src/testUtils/weightedShardSequencer.ts",
    ]),
  ),
  shards: 6,
}).pipe(Step.timeout("45 minutes"));

const testWeb = Vitest.files({
  ...suite,
  name: "test-web",
  dir: "apps/web",
  tests: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  inputs: Files.imports("apps/web/vitest.config.ts"),
  shards: 2,
  args: ["--passWithNoTests", "--project", "unit*", ...workers],
}).pipe(Step.timeout("30 minutes"));

const testMobile = Vitest.files({
  ...suite,
  name: "test-mobile",
  dir: "apps/mobile",
  tests: ["**/*.test.ts", "**/*.test.tsx"],
  inputs: Files.union(
    Files.of("vitest.config.ts"),
    Files.imports([longTempDir, aliases["expo-crypto"]]),
  ),
  args: ["--config", "../../vitest.config.ts", "--dir", ".", ...workers],
}).pipe(Step.timeout("20 minutes"));

const testDesktop = Vitest.files({
  ...suite,
  name: "test-desktop",
  dir: "apps/desktop",
  tests: ["**/*.test.ts", "**/*.test.js", "**/*.test.mjs"],
  inputs: Files.imports(["apps/desktop/vite.config.ts", longTempDir]),
  args: ["--passWithNoTests", ...workers],
  before: ["node", "scripts/ensure-electron-runtime.mjs"],
}).pipe(Step.timeout("20 minutes"));

const testClientRuntime = Vitest.files({
  ...suite,
  name: "test-client-runtime",
  dir: "packages/client-runtime",
  tests: ["src/**/*.test.ts"],
  inputs: Files.imports(["packages/client-runtime/vite.config.ts", longTempDir]),
  args: workers,
}).pipe(Step.timeout("20 minutes"));

const testShared = Vitest.files({
  ...suite,
  name: "test-shared",
  dir: "packages/shared",
  tests: ["src/**/*.test.ts"],
  inputs: Files.union(Files.of("vitest.config.ts"), Files.imports(longTempDir)),
  args: ["--config", "../../vitest.config.ts", "--dir", ".", ...workers],
}).pipe(Step.timeout("20 minutes"));

/** Vite+ `--filter` arguments that select the packages in `dirs`. */
const filters = (dirs: ReadonlyArray<string>) => dirs.flatMap((dir) => ["--filter", `./${dir}`]);

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

const testPackages = Task.make("test-packages", {
  shell,
  setup: install,
  inputs: Files.union(
    Files.of("vitest.config.ts", ...smallSuites),
    Files.imports([...smallSuites.map((dir) => `${dir}/**/*.test.ts`), longTempDir], { aliases }),
  ),
  run: cmd`vp run --cache --parallel --concurrency-limit 1 ${filters(smallSuites)} test ${workers}`,
}).pipe(Step.timeout("20 minutes"));

/** The repository scripts' tests read manifests, lockfiles and configs all over the repository. */
const testScripts = Task.make("test-scripts", {
  shell,
  setup: install,
  run: cmd`vp run --cache --filter ./scripts test ${workers}`,
}).pipe(Step.timeout("30 minutes"));

/**
 * Typechecks of package groups, one package at a time, each when its packages' tsconfigs or what
 * their sources import, types included, changed. `sources` are what the tsconfigs include. The
 * server checks alone: tsgo needs about 4 GB for it.
 */
const typecheck = (name: string, dirs: ReadonlyArray<string>, sources: ReadonlyArray<string>) =>
  Task.make(`typecheck-${name}`, {
    shell,
    setup: install,
    inputs: Files.union(
      Files.of("tsconfig.base.json", ...dirs.map((dir) => `${dir}/tsconfig.json`)),
      Files.imports(sources, { aliases, types: true }),
    ),
    run: cmd`vp run --cache --concurrency-limit 1 ${filters(dirs)} typecheck`,
  }).pipe(Step.timeout("30 minutes"));

const typechecks = [
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

/** Runs the release workflows' scripts against copies of the manifests, lockfile and patches. */
const releaseSmoke = Task.make("release-smoke", {
  shell,
  setup: install,
  inputs: Files.union(
    Files.of(".github/scripts"),
    Files.imports([
      "scripts/release-smoke.ts",
      "scripts/update-release-package-versions.ts",
      "scripts/resolve-nightly-release.ts",
      "scripts/merge-update-manifests.ts",
    ]),
  ),
  run: cmd`node scripts/release-smoke.ts`,
}).pipe(Step.timeout("10 minutes"));

/** pnpm resolves the manifests to exactly the committed lockfile. */
const forkLockfile = Task.make("fork-lockfile", {
  shell,
  setup: install,
  inputs: Files.of("scripts/fork-lockfile.ts"),
  run: cmd`node scripts/fork-lockfile.ts --check`,
}).pipe(Step.timeout("10 minutes"));

/** The production deploy lock matches the lockfile, formatted by Vite+. */
const deployLock = Task.make("deploy-lock", {
  shell,
  setup: install,
  inputs: Files.of("pnpm-deploy-lock.yaml", "vite.config.ts", "scripts/sync-pnpm-deploy-lock.mjs"),
  run: cmd`node scripts/sync-pnpm-deploy-lock.mjs --check`,
}).pipe(Step.timeout("10 minutes"));

/** The update feed's manifest, which the OTA update and the TestFlight build agree on. */
const updatesUrl = "https://t3code-updates.schnau.dev/manifest";

/**
 * Dependencies on the Apple builder, from its own Node through corepack: this flake's pinned Node
 * and CocoaPods misbehave on macOS 27. The builder sits behind a slow home uplink, where pnpm's 60 s
 * default aborts large tarballs when many download at once.
 */
const appleInstall = Setup.make("apple-install", {
  platform: "aarch64-darwin",
  inputs: Files.glob(
    "**/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "patches/**/*.patch",
  ),
  run: cmd`corepack pnpm install --frozen-lockfile --trust-lockfile --network-concurrency 4`,
  env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", pnpm_config_fetch_timeout: "600000" },
  keep: ["node_modules"],
  path: ["node_modules/.bin"],
});

/**
 * The desktop and iOS apps ship from every deployed commit. Packaging, signing and TestFlight run on
 * the Apple builder (m1) in Hauke's GUI session, where Xcode and the signing keychain work; the
 * update feed lives on srv-2. A desktop or mobile failure never holds up the deploy.
 */
const apps = (promote: Step.Any) => {
  const release = "desktop-release";
  const desktopPackage = Task.make("desktop-package", {
    platform: "aarch64-darwin",
    setup: appleInstall,
    after: [promote],
    // Rust comes from the builder's own pinned nixpkgs registry entry.
    run: cmd`nix shell nixpkgs#cargo nixpkgs#rustc --command node scripts/desktop-package.ts --output-dir ${release}`,
    outputs: { release },
  }).pipe(Step.timeout("60 minutes"));
  // The update feed's directories exist on srv-2 only, so these two never move to an agent.
  const desktopPublish = Task.make("desktop-publish", {
    shell,
    setup: install,
    run: cmd`node scripts/desktop-publish.ts --artifacts-dir ${desktopPackage.outputs.release}`,
    offload: false,
  }).pipe(Step.timeout("15 minutes"));
  const runtime = "mobile-runtime-version";
  const mobileUpdate = Task.make("mobile-update", {
    shell,
    setup: install,
    after: [promote],
    run: cmd`node scripts/mobile-update.ts publish --updates-url ${updatesUrl} --runtime-version-file ${runtime}`,
    outputs: { runtime },
    offload: false,
  }).pipe(Step.timeout("30 minutes"));
  const testflight = Task.make("testflight", {
    platform: "aarch64-darwin",
    setup: appleInstall,
    run: cmd`node scripts/mobile-testflight.ts --updates-url ${updatesUrl} --runtime-version-file ${mobileUpdate.outputs.runtime}`,
  }).pipe(Step.timeout("120 minutes"));
  return [desktopPublish, testflight];
};

export default Project.standard({
  flake,
  checks: [
    ...deps,
    check,
    ...typechecks,
    testServer,
    testWeb,
    testMobile,
    testDesktop,
    testClientRuntime,
    testShared,
    testPackages,
    testScripts,
    releaseSmoke,
    forkLockfile,
    deployLock,
  ],
  afterDeploy: apps,
  // Runs every check from scratch, which also shows whether a test file's key misses something it reads.
  nightly: "0 3 * * *",
});
