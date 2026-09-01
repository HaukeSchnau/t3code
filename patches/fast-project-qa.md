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
- `Justfile` owns the QA tasks. The Gitea workflow runs independent tasks as separate jobs and shards
  the serial server test suite across three jobs.
- TypeScript package checks run one at a time on the memory-constrained runners. Separate Gitea jobs
  provide cross-host parallelism without making two large `tsgo` processes page inside one cgroup.

The generic workspace runner is intentionally kept separate from the T3 Code hooks so it can move to
the shared infrastructure modules once Studienbuch uses the same command contract.
