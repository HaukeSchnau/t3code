# Fast project QA

## Fork requirement

Changes pushed to the fork must reach the release gate within a few minutes on Kiln, the fleet's
self-hosted CI. CI must still run the complete static checks, TypeScript checks, tests, release smoke,
and fork lockfile check.

## Implementation

- `.#ci` contains only the tools needed to prepare and verify a checkout.
- Kiln (`.kiln/ci.ts`) runs each QA task in a persistent workspace slot. The `install` setup
  (`Pnpm.install` from `@kiln/std`) installs dependencies once per lockfile state and keeps the
  apps' builds and caches between tasks; each task starts from a copy of the prepared workspace.
- CI installs the committed lockfile with `--frozen-lockfile --trust-lockfile`, matching Nix release
  builds. Dependency changes retain normal pnpm policy checks when resolving the lockfile; CI does
  not recheck every locked version against live registry metadata. That pnpm 11.10 verification
  exhausted the 15-minute setup budget in run 387 before any QA command ran.
- Server-test temporary files live below T3 Code's persistent CI cache. The worker's private `/tmp`
  is intentionally small and cannot hold concurrent copies of realistic workspaces.
- `Justfile` owns the QA commands, and `.kiln/ci.ts` makes them steps: formatting and linting, six
  typecheck groups, a test step for each package with a sizeable suite, one for the small packages,
  one for the repository scripts, and the release smoke.
- The server, web, mobile, desktop, client-runtime and shared suites run file by file (Kiln's `each`
  over `Files.imports`). A test file runs again only when it, something it imports or its package's
  other files changed, and Kiln splits the files that run across jobs by their recorded durations.
  `qa-test-server` and `qa-test-package` run Vitest directly on the given files and write the
  package's `.vitest-report.json`, which tells Kiln what passed. They bypass `vp run --cache`, so a
  report never holds replayed results. A nightly run repeats every check without reuse.
- A test that reads repository files its imports don't show has a `// kiln: always` comment line and
  runs every time: `apps/server/src/cli/triagePrompt.test.ts` reads the triage playbook and
  `apps/mobile/src/dependency-graph.test.ts` the whole source tree. Keep the comments when upstream
  changes those files, and add one to a test that starts reading files by path.
- The small packages' suites (contracts, effect-acp, effect-codex-app-server, ssh, tailscale, relay
  and the oxlint plugin) run together when their directories or anything their tests import changed.
  The repository scripts' tests read manifests, lockfiles and configs all over the repository, so
  they run on every change. The release smoke depends only on the manifests, lockfiles, workspace
  file, patches and its three scripts.
- Typecheck groups are keyed by what their tsconfigs include and everything it imports, types
  included. Each group checks its packages one at a time with Vite+'s task cache. The server checks
  alone, since tsgo needs about 4 GB for it, and incrementally: its `tsconfig.json` sets
  `incremental`, and Kiln keeps `apps/server/tsconfig.tsbuildinfo` between runs. On srv-2 at load 35
  to 45 a cold check took 387 s, an unchanged one 16 s and one after a one-file edit 125 s. Vite+
  never caches it because it rewrites the build info it read. Remove `incremental` if upstream makes
  the server incremental or composite.
- Upstream runs the orchestrator replay fixtures as one file, `OrchestratorReplayFixtures.integration.test.ts`:
  123 replays that took 12 to 21 minutes on Kiln, and a file is the smallest unit Kiln and Vitest
  split. The fork moves its code to `OrchestratorReplayFixtures.testkit.ts` and runs it as six
  `OrchestratorReplayFixtures.part<N>.integration.test.ts` files of about two minutes each. Port
  upstream changes to the old file into the testkit. Remove the split once upstream splits the file.
- srv-2's load varies between 10 and 45, so a few upstream tests get more time. The orchestrator MCP
  toolkit scenario took up to 121 s against the 120 s default; it has 600 s, and its polling loops
  give up after 10,000 rounds instead of 1,000. The ACP direct Stop test waits 30 s instead of 3 s
  for a teardown that itself sleeps a 1 s grace and waits up to 10 s. The timeline tests' import
  hook in `MessagesTimeline.test.tsx` has 120 s instead of 30 s. Keep these when upstream changes
  those tests.
- `apps/server/src/testUtils/gitConfig.setup.ts` appends its git settings once per process instead
  of once per test file, so server tests can later share a worker without growing every git
  child's environment.
- Cancelling a run kills each task's process group 10 seconds after TERM. TypeScript 7's native
  `tsc` catches TERM and keeps checking until it finishes; under memory pressure a cancelled
  typecheck ran for hours.
