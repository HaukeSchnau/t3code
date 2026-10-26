import { Files, Flake, Nix, Setup, Step, Task, cmd } from "@calder-ci/core";
import { Project, Vitest } from "@calder-ci/std";
import { flake } from "./flake.ts";

const shell = flake.devShells.ci;

/**
 * The committed lockfile as is, like the Nix release build; rechecking every locked version against
 * the registry stalled cold installs. `scripts/ci-pnpm-install.ts` forces the install when the patch
 * set changed, since pnpm can leave a newly patched package unpatched in a kept node_modules.
 */
const install = Setup.make("install", {
  shell,
  inputs: Files.union(
    // pnpm 12 rejects a frozen install when the pnpmfile no longer matches the lockfile's checksum.
    Files.glob("**/package.json", "pnpm-lock.yaml", ".pnpmfile.cjs"),
    Files.optional(Files.glob("pnpm-workspace.yaml", ".npmrc", "patches/**/*.patch")),
    Files.of("scripts/ci-pnpm-install.ts"),
  ),
  run: cmd`node scripts/ci-pnpm-install.ts`,
  keep: ["node_modules", ".pnpm-store", "*.tsbuildinfo"],
  path: ["node_modules/.bin"],
});

/** The filtered pnpm stores the release builds from; a stale hash fails here first. */
const deps = ["web", "server", "runtime"].map((part) =>
  Nix.build(Flake.select(flake.packages.t3code, `pnpmDeps.${part}`), { name: `deps-${part}` }),
);

const check = Task.make("static", { shell, setup: install, run: cmd`vp check` }).pipe(
  Step.timeout("30 minutes"),
);

/** A command line of several steps. */
const sh = (script: string, ...args: ReadonlyArray<string>) => cmd`bash -c ${script} sh ${args}`;

/** Unused files, dependencies and exports, which knip finds across the whole repository. */
const knip = Task.make("knip", { shell, setup: install, run: cmd`vp run knip:check` }).pipe(
  Step.timeout("15 minutes"),
);

/** The generated GraphQL operations match their documents and schemas. */
const graphql = Task.make("graphql", {
  shell,
  setup: install,
  inputs: Files.union(
    Files.of(
      "packages/source-control-github/graphql.config.ts",
      "packages/source-control-github/schema",
      "apps/server/graphql.config.ts",
      "apps/server/schema",
    ),
    Files.glob(
      "packages/source-control-github/src/**/*.graphql",
      "packages/source-control-github/src/**/*.graphql.ts",
      "apps/server/src/device/**/*.graphql",
      "apps/server/src/device/**/*.graphql.ts",
    ),
  ),
  run: cmd`vp run --filter @t3tools/source-control-github --filter t3 generate --check`,
}).pipe(Step.timeout("10 minutes"));

/**
 * The web, server and desktop bundles build, and the preload bundle exposes the desktop bridge under
 * Electron's sandbox. Linux builds the same bundles as macOS; packaging and signing stay with
 * `desktop-package`.
 */
const desktopBuild = Task.make("desktop-build", {
  shell,
  setup: install,
  inputs: Files.union(
    Files.workspace("apps/desktop", "apps/server", "apps/web"),
    Files.of("assets", "native/browser-secret", "scripts/lib"),
  ),
  run: sh("vp run build:desktop && node apps/desktop/scripts/verify-preload-bundle.mjs"),
}).pipe(Step.timeout("30 minutes"));

const nativeShell = flake.devShells["ci-native"];

const rustCrates = ["native/resource-monitor", "native/kde-snap-shot", "native/hyprland-snap-shot"];

/** Formatting and tests of the Rust helpers. Build output doesn't carry over, so a run compiles cold. */
const rust = Task.make("rust", {
  shell: nativeShell,
  inputs: Files.of(...rustCrates),
  run: sh(
    'for crate; do cargo fmt --manifest-path "$crate/Cargo.toml" -- --check; done; ' +
      'for crate; do cargo test --locked --manifest-path "$crate/Cargo.toml"; done',
    ...rustCrates,
  ),
}).pipe(Step.timeout("30 minutes"));

/**
 * SwiftLint, ktlint and detekt over the mobile app's native sources. Linux SwiftLint has no
 * SourceKit, so it skips the rules that need it.
 */
const lintMobile = Task.make("lint-mobile", {
  shell: nativeShell,
  setup: install,
  inputs: Files.union(
    Files.of("apps/mobile/.editorconfig", "apps/mobile/.swiftlint.yml", "apps/mobile/detekt.yml"),
    Files.glob("apps/mobile/**/*.swift", "apps/mobile/**/*.kt"),
    Files.optional(Files.glob("apps/mobile/**/*.kts")),
    Files.imports("scripts/mobile-native-static-check.ts"),
  ),
  run: cmd`vp run lint:mobile`,
}).pipe(Step.timeout("15 minutes"));

/** PR evidence belongs on the pull request, not in the repository. */
const prAssets = Task.make("pr-assets", {
  inputs: Files.optional(Files.of(".github/pr-assets")),
  run: sh(
    'if [ -e .github/pr-assets ]; then echo "PR evidence must be uploaded, not committed:" >&2; find .github/pr-assets -type f >&2; exit 1; fi',
  ),
}).pipe(Step.timeout("5 minutes"));

/** The workflow scripts' own tests. `relay-state-output.test.cjs` runs in `release-smoke`. */
const githubScripts = Task.make("github-scripts", {
  shell,
  inputs: Files.of(
    ".github/scripts",
    ".github/workflows/release.yml",
    ".github/workflows/web-preview.yml",
  ),
  run: sh(
    "python3 -B .github/scripts/stage-preview-bundle.test.py && node --test " +
      ".github/scripts/check-nightly-release.test.cjs " +
      ".github/scripts/vercel-deployment-output.test.cjs " +
      ".github/scripts/thread-transfer-report.test.cjs",
  ),
}).pipe(Step.timeout("10 minutes"));

/** The import aliases of the root Vitest config and the web app's tsconfig. */
const aliases = {
  "~": "apps/web/src",
  "expo-crypto": "apps/mobile/src/test-support/expo-crypto.ts",
};

/** The root Vitest config's setup files, which most packages' suites run with. */
const setupFiles = [
  "packages/shared/src/testing/longTempDir.ts",
  "packages/shared/src/testing/providerEnv.ts",
];

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
      ...setupFiles,
      "packages/shared/src/testing/isolatedTestFiles.ts",
      "apps/server/src/testUtils/gitConfig.setup.ts",
      "apps/server/src/testUtils/managedServiceEnv.setup.ts",
      "apps/server/src/testUtils/weightedShardSequencer.ts",
    ]),
  ),
  shards: 6,
}).pipe(Step.timeout("45 minutes"));

/**
 * The web suite's unit and browser projects run as separate steps. Together, three unit workers and
 * three Chromium sessions peaked at 4.8 GB on srv-2, over a Calder worker's 4.5 GB, and in run 281
 * a shard thrashed against that limit until it timed out. Run apart on one shard's files, they
 * peaked at 3.6 and 2.9 GB.
 */
const web = {
  ...suite,
  dir: "apps/web",
  inputs: Files.imports([
    "apps/web/vitest.config.ts",
    ...setupFiles,
    "apps/web/test/browserSetup.ts",
    "apps/web/test/browserWaitFor.ts",
  ]),
};

// `tests` can't leave out the browser files, so this step gets them too and runs none of their
// tests.
const testWeb = Vitest.files({
  ...web,
  name: "test-web",
  tests: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  shards: 2,
  args: ["--passWithNoTests", "--project", "unit*", ...workers],
}).pipe(Step.timeout("20 minutes"));

/**
 * The CI shell points the config at nixpkgs' headless Chromium. Most of a file's time goes to
 * setting up its browser session: a shard of 73 files took 20 minutes in run 281.
 */
const testWebBrowser = Vitest.files({
  ...web,
  name: "test-web-browser",
  tests: ["src/**/*.browser.test.ts", "src/**/*.browser.test.tsx"],
  shards: 3,
  args: ["--passWithNoTests", "--project", "browser", ...workers],
}).pipe(Step.timeout("30 minutes"));

const testMobile = Vitest.files({
  ...suite,
  name: "test-mobile",
  dir: "apps/mobile",
  tests: ["**/*.test.ts", "**/*.test.tsx"],
  // The config loads babel.config.js through `require`, which `Files.imports` doesn't follow.
  inputs: Files.union(
    Files.of("apps/mobile/babel.config.js"),
    Files.imports(["apps/mobile/vitest.config.ts", ...setupFiles, aliases["expo-crypto"]]),
  ),
  args: ["--config", "vitest.config.ts", "--project", "unit", "--project", "react", ...workers],
}).pipe(Step.timeout("20 minutes"));

const testDesktop = Vitest.files({
  ...suite,
  name: "test-desktop",
  dir: "apps/desktop",
  tests: ["**/*.test.ts", "**/*.test.js", "**/*.test.mjs"],
  inputs: Files.imports(["apps/desktop/vite.config.ts", ...setupFiles]),
  args: ["--passWithNoTests", ...workers],
  before: ["node", "scripts/ensure-electron-runtime.mjs"],
}).pipe(Step.timeout("20 minutes"));

const testClientRuntime = Vitest.files({
  ...suite,
  name: "test-client-runtime",
  dir: "packages/client-runtime",
  tests: ["src/**/*.test.ts"],
  inputs: Files.imports(["packages/client-runtime/vite.config.ts", ...setupFiles]),
  // Upstream's own config keeps Vitest's 5 s default; the root config gives loaded workers 60 s.
  args: [...workers, "--testTimeout", "60000"],
}).pipe(Step.timeout("20 minutes"));

const testShared = Vitest.files({
  ...suite,
  name: "test-shared",
  dir: "packages/shared",
  tests: ["src/**/*.test.ts"],
  inputs: Files.union(Files.of("vitest.config.ts"), Files.imports(setupFiles)),
  args: ["--config", "../../vitest.config.ts", "--dir", ".", ...workers],
}).pipe(Step.timeout("20 minutes"));

/** Vite+ `--filter` arguments that select the packages in `dirs`. */
const filters = (dirs: ReadonlyArray<string>) => dirs.flatMap((dir) => ["--filter", `./${dir}`]);

/** One package per provider and per source-control host. */
const integrationPackages = [
  "packages/provider-acp",
  "packages/provider-acp-registry",
  "packages/provider-core",
  "packages/provider-cursor",
  "packages/provider-grok",
  "packages/provider-muse",
  "packages/provider-opencode",
  "packages/provider-pi",
  "packages/provider-testing",
  "packages/source-control-azure-devops",
  "packages/source-control-bitbucket",
  "packages/source-control-core",
  "packages/source-control-definitions",
  "packages/source-control-forgejo",
  "packages/source-control-gitcafe",
  "packages/source-control-github",
  "packages/source-control-gitlab",
  "packages/source-control-testing",
];

/** Packages with small suites run whole when they or anything their tests import changed. */
const packageSuites = (name: string, dirs: ReadonlyArray<string>) =>
  Task.make(name, {
    shell,
    setup: install,
    inputs: Files.union(
      Files.of("vitest.config.ts", ...dirs),
      Files.imports([...dirs.map((dir) => `${dir}/**/*.test.ts`), ...setupFiles], { aliases }),
    ),
    // No `--cache`: the task-cache tests start their own `vp run`, which fails under a caching one.
    run: cmd`vp run --parallel --concurrency-limit 1 ${filters(dirs)} test ${workers}`,
  }).pipe(Step.timeout("20 minutes"));

const testPackages = packageSuites("test-packages", [
  "packages/contracts",
  "packages/effect-acp",
  "packages/effect-codex-app-server",
  "packages/ssh",
  "packages/tailscale",
  "infra/relay",
  "infra/task-cache",
  "oxlint-plugin-t3code",
]);

// The provider and source-control packages took the package step past 20 minutes on their own.
const testIntegrations = packageSuites(
  "test-integrations",
  // These packages have no tests of their own.
  integrationPackages.filter(
    (dir) =>
      ![
        "packages/provider-testing",
        "packages/source-control-definitions",
        "packages/source-control-testing",
      ].includes(dir),
  ),
);

/** The repository scripts' tests read manifests, lockfiles and configs all over the repository. */
const testScripts = Task.make("test-scripts", {
  shell,
  setup: install,
  // No `--cache`, as in `packageSuites`.
  run: cmd`vp run --filter ./scripts test ${workers}`,
}).pipe(Step.timeout("30 minutes"));

/**
 * Typechecks of package groups, one package at a time, each when its packages' tsconfigs or what
 * their sources import, types included, changed. `sources` are what the tsconfigs include. `args`
 * go to each package's typecheck script.
 */
const typecheck = (
  name: string,
  dirs: ReadonlyArray<string>,
  sources: ReadonlyArray<string>,
  args: ReadonlyArray<string> = [],
) =>
  Task.make(`typecheck-${name}`, {
    shell,
    setup: install,
    inputs: Files.union(
      Files.of("tsconfig.base.json", ...dirs.map((dir) => `${dir}/tsconfig.json`)),
      Files.imports(sources, { aliases, types: true }),
    ),
    run: cmd`vp run --cache --concurrency-limit 1 ${filters(dirs)} typecheck ${args}`,
  }).pipe(Step.timeout("30 minutes"));

const corePackages = [
  "packages/client-runtime",
  "packages/contracts",
  "packages/shared",
  "packages/effect-acp",
  "packages/effect-codex-app-server",
  "packages/ssh",
  "packages/tailscale",
];

const typechecks = [
  // The server checks alone and with one checker: a cold check peaked at 4.7 GB with tsc-rs's
  // default checkers and 3.1 GB with one, against a Calder worker's 4.5 GB.
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
    ["--checkers", "1"],
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
      "apps/web/scripts/warm-dep-cache.ts",
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
  typecheck("packages", corePackages, [
    ...corePackages.map((dir) => `${dir}/src/**/*.ts`),
    "packages/effect-acp/scripts/**/*.ts",
    "packages/effect-acp/test/**/*.ts",
    "packages/effect-codex-app-server/scripts/**/*.ts",
    "packages/effect-codex-app-server/test/**/*.ts",
  ]),
  typecheck(
    "integrations",
    integrationPackages,
    integrationPackages.map((dir) => `${dir}/src/**/*.ts`),
  ),
  // Astro checks .astro files, whose imports aren't followed, so marketing counts as a whole.
  typecheck(
    "tools",
    ["infra/relay", "infra/task-cache", "scripts", "oxlint-plugin-t3code", "apps/marketing"],
    [
      "infra/relay/**/*.ts",
      "infra/task-cache/**/*.ts",
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
  inputs: Files.union(
    Files.of("pnpm-deploy-lock.yaml", "scripts/sync-pnpm-deploy-lock.mjs"),
    Files.imports("vite.config.ts"),
  ),
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
    ".pnpmfile.cjs",
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
    knip,
    graphql,
    desktopBuild,
    rust,
    lintMobile,
    githubScripts,
    prAssets,
    ...typechecks,
    testServer,
    testWeb,
    testWebBrowser,
    testMobile,
    testDesktop,
    testClientRuntime,
    testShared,
    testPackages,
    testIntegrations,
    testScripts,
    releaseSmoke,
    forkLockfile,
    deployLock,
  ],
  afterDeploy: apps,
  // Runs every check from scratch, which also shows whether a test file's key misses something it reads.
  nightly: "0 3 * * *",
});
