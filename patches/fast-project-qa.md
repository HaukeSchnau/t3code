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
- `Justfile` owns the QA tasks. The Gitea workflow runs formatting and linting, TypeScript checks,
  non-server tests, release smoke, and server shards as independent jobs. The serial server test
  suite is split across three jobs.
- TypeScript package checks run one at a time inside each runner. Client and remaining package checks
  use separate Gitea jobs for cross-host parallelism without making two large `tsgo` processes page
  inside one cgroup. Successful package checks use Vite+'s persistent task cache.
- Successful test tasks and server shards also use Vite+'s persistent task cache. Forwarded shard
  arguments are part of its cache fingerprint, so each shard remains isolated while unchanged work
  can be replayed on later runs.
- Workflow steps `exec` the Nix development command so cancellation signals reach the job process
  instead of stopping at the workflow shell.

The generic runner is also published by `nix-infra-modules` as `ci-workspace-runner`. This repository
keeps a matching shim until its existing infrastructure input can be upgraded independently; the
project hooks and command contract are already compatible with the shared package.
