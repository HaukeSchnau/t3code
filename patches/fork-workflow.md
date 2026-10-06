# Fork workflow

## Goal

Keep this personal fork easy to sync with upstream while preserving local patches and making future
merge conflicts easier to reason about.

## Source context

- Session archive thread `019e9227-87a9-71d1-a3ac-116f9b9bc6bc` recorded the fork strategy
  discussion. It chose merge-based syncing from upstream over rebasing the fork-only patch stack.
- `AGENTS.md` records the operational rules for syncing, publishing, and patch documentation.

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
- Preserve the fork's applied migration ids and names. The registry in
  `apps/server/src/persistence/Migrations.ts` is authoritative. Append each new upstream migration at
  the next free fork id instead of adopting upstream's numbering. Every upstream migration from 033
  onward therefore runs under a different id (upstream 054, 055 and 056 run as 77, 78 and 79), and
  some source filenames share a numeric prefix with a fork migration.
- `ORCHESTRATION_V2_MIGRATION_ID` in `Migrations.ts` holds the fork id of upstream's
  `OrchestrationV2` migration (78). `runMigrations` uses it to decide when to call upstream's
  `reconcileV2PreviewMigration`, where upstream compares against a literal 55. That reconcile only
  rewrites ledgers that recorded `OrchestrationV2` at 53 or 54, which upstream preview builds did,
  so it does nothing on fork databases. Move the constant with the migration if its id changes.
- Upstream's `docs/internals/legacy-orchestration-migration.md` warns that the migrator compares
  ids only, so a fork migration at an id upstream later assigns masks upstream's migration forever.
  The fork's mapping avoids that by owning the whole id sequence. Fork databases only run fork
  builds, and each upstream migration takes the next free fork id, so the fork never reassigns an
  id to a different migration. The divergence warning in `runMigrations` compares the ledger with
  the running build's manifest, so it stays silent on a fork database unless an upstream build has
  touched it.
- Vitest config lives in `vitest.config.ts` files, separate from the production `vite.config.ts`
  files that Nix packaging builds with (see [Nix flake packaging](nix-flake-packaging.md)). The
  root `vitest.config.ts` serves packages without their own, and their test scripts run
  `vp test run --config ../../vitest.config.ts --dir .`. Upstream's scripts point at
  `../../vite.config.ts`, so rewrite each new or changed upstream test script to the fork's form.
  Tests import from `vite-plus/test`. The fork has no direct `vitest` dependency or catalog entry.
- Push completed fork work to a feature bookmark with `jj-push <bookmark>` and open a pull request
  targeting `main`, including upstream sync merges. Do not push directly to `main`.
- Use Jujutsu for VCS operations unless explicitly instructed otherwise.
- Keep new fork patches minimally invasive:
  - prefer extension points and small adapters
  - avoid broad upstream rewrites
  - avoid formatting churn in upstream-owned files
  - isolate custom logic when upstream-owned code must be touched
- Document every fork-specific feature or custom patch in `patches/*.md`.

## Upstream touch points

- `AGENTS.md`
- `Justfile`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `apps/server/src/persistence/Migrations.ts`
- package `test` scripts

## Non-goals

- Do not use routine upstream rebases that rewrite the fork patch stack.
- Do not bypass the pull request workflow for personal-fork publishing.
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
