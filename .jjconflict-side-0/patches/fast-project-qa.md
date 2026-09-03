# Fast project QA

## Fork requirement

Changes pushed to the fork must reach the release gate within a few minutes on the two self-hosted
Gitea runners. CI must still run the complete static checks, TypeScript checks, tests, release smoke,
and fork lockfile check.

## Implementation

- `.#ci` contains only the tools needed to prepare and verify a checkout.
- `scripts/ci-workspace-run.sh` refreshes a locked, architecture-specific persistent workspace. It
  treats project setup and QA commands as opaque executables and contains no Node or TypeScript
  behavior.
- `.ci/` owns T3 Code's retained paths, environment, and dependency fingerprint.
- Server-test temporary files live below T3 Code's persistent CI cache. The runner's private `/tmp`
  is intentionally small and cannot hold concurrent copies of realistic workspaces.
- `Justfile` owns the QA tasks. The Gitea workflow runs formatting and linting, TypeScript checks,
  non-server tests, release smoke, and server shards as independent jobs. The serial server test
  suite is split across three jobs.
- TypeScript package checks run one at a time inside each runner. Client and remaining package checks
  use separate Gitea jobs for cross-host parallelism without making two large `tsgo` processes page
  inside one cgroup. Successful package checks use Vite+'s persistent task cache.
- Successful package test tasks also use Vite+'s persistent task cache. Server tests run Vitest
  directly because they modify tracked inputs and cannot be cached; direct execution also preserves
  T3 Code's project-owned temporary-directory environment.
- Package tests use two-way outer concurrency. Each package's Vitest process owns its own worker
  pool, so higher outer fan-out oversubscribes the 12-core runner and crosses its soft memory limit.
- Workflow steps `exec` the Nix development command. The workspace runner supervises a dedicated
  project-command process group and terminates it even when Gitea kills the outer runner before
  shell traps can run. It also captures descendants before cancellation so helpers that create
  their own sessions do not escape cleanup. Cancellation reads the process table once rather than
  spawning one `ps` command per descendant, which keeps it responsive when a job reaches its memory
  limit.
- T3 Code jobs request the `t3code-ci` runner pool. Its two instances have separate stable workspace
  slots, so they can run concurrently without claiming the runner reserved for another project.

The generic runner is also published by `nix-infra-modules` as `ci-workspace-runner`. This repository
keeps a matching shim until its existing infrastructure input can be upgraded independently; the
project hooks and command contract are already compatible with the shared package.
