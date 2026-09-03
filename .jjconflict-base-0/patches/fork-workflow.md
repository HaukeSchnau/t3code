# Fork Workflow

## Goal

Keep this personal fork easy to sync with upstream while preserving local patches and making future
merge conflicts easier to reason about.

## Source Context

- Backfilled from the current fork delta against `main@upstream`.
- Session archive thread `019e9227-87a9-71d1-a3ac-116f9b9bc6bc` recorded the fork strategy
  discussion. The selected direction was merge-based syncing from upstream rather than routinely
  rebasing the fork-only patch stack.
- The current `AGENTS.md` records the operational rules for syncing, publishing, and patch
  documentation.

## Requirements

- Treat `origin/main` as the personal fork branch.
- Keep `upstream/main` as the source of upstream changes.
- Before starting work, fetch both remotes sequentially:
  - `jj git fetch --remote origin`
  - `jj git fetch --remote upstream`
- Inspect `jj status` after fetching.
- When upstream has advanced, create a dedicated merge sync change from fork `main` and
  `main@upstream`.
- Do not mix feature work into upstream sync merges.
- Resolve `package.json` manifests and `pnpm-workspace.yaml` before resolving the canonical
  lockfile. `pnpm-lock.yaml` is derived output: regenerate it with `pnpm run fork:lockfile` instead of
  hand-merging it. The command enforces the exact pnpm version pinned by the root `packageManager`,
  runs without lifecycle scripts, and accepts the result only after frozen-lockfile validation. It
  then regenerates the deploy lock, refreshes all three Nix dependency hashes concurrently, and
  verifies the Nix release contract.
- Use `pnpm run fork:lockfile:check` for a non-mutating lockfile check. It restores the original
  lockfile on success, staleness, and command failure.
- For large upstream merge conflicts, delegate investigation/resolution to a subagent and then
  review the result before committing.
- Run required checks before committing sync merges.
- Push completed fork work directly to `main` with `jj-push main`.
- Use Jujutsu for VCS operations unless explicitly instructed otherwise.
- Keep new fork patches minimally invasive:
  - prefer extension points and small adapters
  - avoid broad upstream rewrites
  - avoid formatting churn in upstream-owned files
  - isolate custom logic when upstream-owned code must be touched
- Document every fork-specific feature or custom patch in `patches/*.md`.

## Upstream Touch Points

- `AGENTS.md`
- `Justfile`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`

## Non-Goals

- Do not use routine upstream rebases that rewrite the fork patch stack.
- Do not open pull requests for normal personal-fork publishing.
- Do not silently carry undocumented fork patches.

## Verification

- `jj log -r 'main@upstream..main' --no-graph` to inspect fork-only commits.
- `jj diff --from main@upstream --to main --summary` to inspect fork delta.
- `pnpm run fork:reconciliation-report -- --from main@upstream --to main` produces a deterministic,
  read-only report of historical upstream-sync reconciliation paths, repeated hotspots, the current
  fork delta, manifest/lockfile touchpoints, and generated-file warnings. The script only invokes
  `jj log` and `jj diff`; it never mutates Jujutsu state.
- `pnpm run fork:lockfile:check` verifies that the canonical lockfile can be reproduced and passes a
  frozen validation.
- `pnpm run fork:lockfile` keeps the canonical lockfile, deploy lock, and fixed-output Nix hashes in
  one workflow. `just qa-nix-deps` provides the fast, non-mutating dependency-store check used
  near the start of CI.
- Run focused tests, lint, and package typechecks for the paths reconciled by the sync. CI owns the
  repository-wide suite unless a maintainer explicitly requests it.
