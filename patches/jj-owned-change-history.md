# T3-Owned JJ Change History

## Goal

Make JJ changes the primary repo-local history surface for T3 Code while T3 Code owns turn/change provenance in its SQLite sidecar database. JJ repos should use actual JJ changes for review and graph workflows; Git repos keep existing checkpoint behavior.

## Product Decisions

- T3 sidecar DB is the authoritative metadata store.
- A turn can touch many JJ changes, and a JJ change can be linked to many turns.
- T3 Code cooperates with Codex-created `jj new` / `jj commit` changes instead of forcing a new change every turn.
- JJ repos replace the old checkpoint diff UI with JJ graph/review flows.
- Non-repo or outside-repo changes remain visible through an external changes fallback lane.

## Sidecar Metadata Model

- `vcs_turn_scopes` records each tracked turn, repository root, start/end JJ operation, boundary change, fallback change, and state.
- `vcs_turn_change_links` records many-to-many turn/change provenance, including role and commit versions.
- `vcs_external_turn_diffs` records provider-reported diffs that cannot be represented by a JJ change.

## Cooperative Turn/Change Boundary Algorithm

At turn start, T3 Code resolves the active cwd, detects JJ, records the current operation and `@`, and only creates a guard WIP when the current change is already non-empty or described. If `@` is clean and undescribed, T3 Code leaves it alone and lets the agent create its own change.

During reconciliation, T3 Code compares operation state and graph snapshots, resolves touched visible changes to stable change IDs, and upserts sidecar links without overwriting agent descriptions.

At turn completion, T3 Code reconciles again. If no agent-created change was linked but the boundary change now has file changes, it links that change as the fallback and describes it as `wip: ...` only if it is still undescribed.

## JJ Command Mapping

- Current operation: `jj op log --limit 1 -T 'id.short() ++ "\n"'`
- Current change: `jj log --no-graph -r @ -T <template>`
- Operation diff: `jj op diff --from <op> --to @ --no-graph`
- Fallback WIP: `jj new -A @ -B @+ -m "wip: <label>"`
- Describe empty fallback: `jj describe -r <change> -m "wip: <label>"`
- Change diff: `jj show --git --context 3 -r <change>`
- Changed files: `jj show --summary -r <change>`
- Prune: `jj abandon 'empty() & description(exact:"") & mutable() & ~working_copies()'`

## UI Replacement Plan

In JJ repos, `diff=1` routes to JJ graph/review instead of the old checkpoint diff panel. Timeline changed-file cards become compact JJ change chips. The graph renders WIP indicators, provenance links, and focused turn review.

## External Changes Fallback

When provider runtime diffs describe non-repo, unsupported, or outside-root changes, T3 Code stores those diffs in `vcs_external_turn_diffs` and exposes them as compact external-change chips and a fallback diff viewer.

## Prune Policy

T3 Code prunes empty undescribed non-working-copy changes on turn start, turn completion, and debounced graph/status refresh. Current workspace commits are always excluded.

## Non-Goals

- Do not store authoritative metadata in JJ descriptions or trailers.
- Do not remove Git checkpoint support for plain Git repos.
- Do not replace GitHub PR flows.
- Do not build operation-log undo UI.
- Do not infer complete metadata for old changes before this feature existed.

## Testing and Verification Checklist

- Migration and repository service tests for scopes, links, and external diffs.
- JJ tracker tests for cooperative guard, fallback linking, pruning, and many-to-many links.
- Contract and RPC tests for graph provenance, thread changes, and change diffs.
- Web tests for JJ timeline chips, graph focus, WIP indicators, and Git fallback.
- Verification: `bun fmt`, `bun lint`, `bun typecheck`, and affected `bun run test` commands.
