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
- `Justfile` owns the QA tasks. Kiln runs formatting and linting, TypeScript checks, non-server
  tests, release smoke, and server shards as independent steps. The serial server test suite is
  split across six shards.
- TypeScript package checks run one at a time inside each task. Client and remaining package checks
  are separate steps for parallelism without making two large `tsgo` processes page inside one
  cgroup. Successful package checks use Vite+'s persistent task cache.
- Successful package test tasks also use Vite+'s persistent task cache. Server tests run Vitest
  directly because they modify tracked inputs and cannot be cached; direct execution also preserves
  T3 Code's project-owned temporary-directory environment.
- Package tests use two-way outer concurrency. Each package's Vitest process owns its own worker
  pool, so higher outer fan-out oversubscribes srv-2 and crosses the worker's soft memory limit.
- Cancelling a run kills each task's process group 10 seconds after TERM. TypeScript 7's native
  `tsc` catches TERM and keeps checking until it finishes; under memory pressure a cancelled
  typecheck ran for hours.
- The non-server test step has a 35-minute limit. Package tests alone took almost 13 minutes in
  run 378, leaving too little of a 15-minute budget for the desktop suite.
