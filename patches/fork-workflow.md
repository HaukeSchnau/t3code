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
- Required repo gates: `vp check` and `vp run typecheck`.
