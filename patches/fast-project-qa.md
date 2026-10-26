# Fast project QA

## Fork requirement

Changes pushed to the fork must reach the release gate within a few minutes on Calder, the fleet's
self-hosted CI. CI must still run every check upstream's GitHub CI (`.github/workflows/ci.yml`) runs,
plus the fork lockfile checks.

## Implementation

- Calder runs `.calder/ci.ts` on pull requests and on pushes to the Gitea `main` branch. Each step
  reports a `calder/<step>` commit status, and branch protection requires them. The three
  fixed-output pnpm store builds (`deps-web`, `deps-server`, `deps-runtime`) are checks of their
  own, so a stale hash fails before the release gate. On `main`, the release deploys to srv-1 and
  srv-2 once every check passed, and then the desktop and mobile steps ship the apps from the Apple
  builder (`desktop-distribution.md`, `mobile-distribution.md`). Inspect runs at
  https://calder.schnau.dev and preview the pipeline with `calder plan --event push:main` or
  `calder plan --event pr:1`.
- After a push, `just ci-watch <revision>` fetches `origin/main`, checks that each new head
  descends from the revision, and follows the head's `calder` commit status. When a later push
  cancels the run, it moves on to the descendant head instead of reporting the cancelled ancestor.
- `.#ci` contains only the tools needed to prepare and verify a checkout.
- Calder (`.calder/ci.ts`) runs each QA task in a persistent workspace slot. The `install` setup
  installs dependencies once per lockfile state and keeps
  `node_modules`, with Vite+'s task cache and Vitest's module cache, and TypeScript build info
  between tasks; each task starts from a copy of the prepared workspace. Build output doesn't carry
  over, since a task would read what another revision built.
- CI installs the committed lockfile with `--frozen-lockfile --trust-lockfile`, matching Nix release
  builds. Dependency changes retain normal pnpm policy checks when resolving the lockfile; CI does
  not recheck every locked version against live registry metadata. That pnpm 11.10 verification
  exhausted the 15-minute setup budget in run 387 before any QA command ran. The install and
  `apple-install` inputs include `.pnpmfile.cjs`: pnpm 12 rejects a frozen install whose pnpmfile no
  longer matches the checksum in the lockfile.
- `scripts/ci-pnpm-install.ts` runs that install. pnpm (seen on 11.10) installs a package that just gained a
  patch without applying it when the slot's kept node_modules already holds the unpatched copy, so
  the script deletes the node_modules folders whenever the lockfile's `patchedDependencies` differ
  from the set recorded in `node_modules/.t3-patch-set`; the kept store makes the reinstall
  quick. `--force` also repairs the patch but installs every platform's optional packages, whose
  missing notices then fail the mobile license manifest. Drop the script once pnpm applies patches
  on incremental installs.
- Server-test temporary files live below T3 Code's persistent CI cache. The worker's private `/tmp`
  is intentionally small and cannot hold concurrent copies of realistic workspaces.
- `.calder/ci.ts` runs the QA tools directly, one step each: `vp check` for formatting and linting,
  `knip:check`, the generated GraphQL drift checks (`graphql`), `build:desktop` with the preload
  verifier (`desktop-build`), `cargo fmt --check` and `cargo test` of the three Rust crates upstream
  checks (`rust`), `lint:mobile`, the `.github/scripts` tests, upstream's PR-asset rejection, seven
  typecheck groups, a test step for each package with a sizeable suite, one for the small packages,
  one for the repository scripts, the release smoke, and the fork and deploy lockfile checks.
- Upstream's `changes` job skips jobs a change cannot affect; Calder reuses a step whose inputs are
  unchanged instead. Knip reads the whole repository and runs on every change. `desktop-build` reads
  the web, server and desktop packages and what they depend on. `graphql`, `rust`, `lint-mobile` and
  `github-scripts` read only their generator inputs, crates, native sources and workflow scripts.
- `rust` and `lint-mobile` run in `.#ci-native`, which adds Rust, SwiftLint, ktlint and detekt to `.#ci`,
  so the other steps' workers don't fetch Rust and a JDK. Upstream lints the native sources on macOS;
  Calder lints them on Linux, where nixpkgs' SwiftLint has no SourceKit and skips the rules that need
  it (`statement_position` in the current config). `desktop-build` builds the bundles on Linux;
  packaging and signing stay with `desktop-package` on the Apple builder.
- The server, web, mobile, desktop, client-runtime and shared suites run file by file (Calder's `each`
  over `Files.imports`). A test file runs again only when it, something it imports or its package's
  other files changed, and Calder splits the files that run across jobs by their recorded durations.
  `Vitest.files` from `@calder-ci/std` runs Vitest in the package on the given files, with the flags of
  the package's test script, and writes the JSON report that tells Calder what passed. It bypasses
  `vp run --cache`, so a report never holds replayed results. A nightly run repeats every check
  without reuse.
- The package and scripts suites run whole through `vp run` without `--cache`, as upstream's CI does.
  Upstream's task-cache tests start their own `vp run`, which exits with an error under a caching
  one: the outer run's file spy reaches the nested process.
- The server unit suite runs as two Vitest projects (`shared` and `isolated`), the web unit suite as
  three (`unit`, `unit-vm` and `unit-isolated`), beside upstream's web `browser` and `renders`
  projects. Most files share one module graph per worker (`isolate: false`) and keep transformed
  modules in `node_modules/.vitest-cache` (`fsModuleCache`), which Calder keeps between runs. Files
  that call `vi.mock`, `vi.doMock`, `vi.stubGlobal` or `vi.stubEnv` run isolated, since a mock or
  stub only reaches modules evaluated after it; `packages/shared/src/testing/isolatedTestFiles.ts`
  finds them, plus a listed few that fail for other reasons. On the web, isolated files get a VM
  context each in `vmForks` workers capped at 512 MB (`unit-vm`); the few that fail in a VM context
  or leak worker state are listed in `apps/web/vitest.config.ts` and run in a process each
  (`unit-isolated`). On srv-2 the whole web suite went from 1167 to 551 CPU seconds with a warm
  cache, and a 40-file sample of small server files from 102 to 15. Upstream isolates every file;
  when an upstream test fails only in a shared project, add it to the config's list. The server's
  `shared` project has its own `sequence.groupOrder`: Vitest rejects a repo-root run (as in
  `check:changed`) whose projects share a group but not a worker count, and `fileParallelism: false`
  gives it one worker.
- A test that reads repository files its imports don't show has a `// calder: always` comment line and
  runs every time: `apps/server/src/cli/triagePrompt.test.ts` reads the triage playbook,
  `apps/mobile/src/dependency-graph.test.ts` the whole source tree, and the web and mobile
  `reactCompilerCoverage.test.ts` compile every source file. Keep the comments when upstream changes
  those files, and add one to a test that starts reading files by path.
- The web `browser` project runs `*.browser.test.{ts,tsx}` in headless Chromium. Playwright's own
  download does not run on NixOS, so `.#ci` points it at nixpkgs' Chromium through
  `T3CODE_BROWSER_TEST_CHROMIUM` (see [NixOS CI portability](nixos-ci-portability.md)). It runs as
  its own step, `test-web-browser`: beside the unit projects, one job outgrew a Calder worker's
  4.5 GB.
- The small packages' suites (contracts, effect-acp, effect-codex-app-server, ssh, tailscale, relay,
  task-cache and the oxlint plugin) run together when their directories or anything their tests import
  changed. The provider and source-control packages run the same way in `test-integrations`, a
  step of their own because together they ran past 20 minutes. Upstream adds a package per
  provider and per source-control host; add new ones to `integrationPackages` in `.calder/ci.ts`.
  The repository scripts' tests read manifests, lockfiles and configs all over the repository, so
  they run on every change. The release smoke and the lockfile checks depend only on what the
  install reads (manifests, lockfiles, workspace file and patches) and the scripts and configs
  they run.
- Typecheck groups are keyed by what their tsconfigs include and everything it imports, types
  included. Each group checks its packages one at a time with Vite+'s task cache. The server checks
  alone and with `--checkers 1`, which only the Calder step passes: a cold tsc-rs check of the server
  peaked at 4.7 GB with the default checkers and 3.1 GB with one, against a Calder worker's 4.5 GB.
  It also checks incrementally: its `tsconfig.json` sets `incremental`, and Calder keeps
  `apps/server/tsconfig.tsbuildinfo` between runs. On srv-2 a cold check with one checker took about
  110 s and an unchanged one 8 s. Vite+ never caches it because it rewrites the build info it read.
  Remove `incremental` if upstream makes the server incremental or composite, and the checker limit
  once Calder can budget memory per step.
- `apps/server/src/testUtils/gitConfig.setup.ts` appends its git settings once per process instead
  of once per test file, so server tests can later share a worker without growing every git
  child's environment.
- Cancelling a run kills each task's process group 10 seconds after TERM. tsc-rs catches TERM and
  keeps checking until it finishes (a cold server check ran on for 4 minutes), and under memory
  pressure a cancelled typecheck ran for hours.
