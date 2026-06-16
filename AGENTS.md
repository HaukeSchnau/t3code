# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Fork Patch Policy

This repository is a fork. Implement new features and patches with the smallest practical footprint on
existing code so future upstream merges stay reviewable and low-risk.

- Prefer extension points, small adapters, and narrowly scoped modules over broad rewrites of upstream code.
- Keep changes close to the behavior they affect, and avoid formatting churn or unrelated cleanup in patched
  files.
- When a fork-specific change must touch upstream-owned code, isolate the custom logic and document the reason,
  requirements, and maintenance risk.
- Thoroughly document every custom patch, fork-specific feature, and its requirements in `./patches/*.md` so
  future syncs can verify whether the patch is still needed and how it should behave.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

## Syncing and Publishing

- This is a personal fork; keep `origin/main` as the fork branch and regularly sync upstream by merging `upstream/main` into it.
- Before starting work, fetch both remotes sequentially with `jj git fetch --remote origin` and `jj git fetch --remote upstream`, then inspect `jj status`.
- If `upstream/main` has advanced, create a dedicated sync merge with `jj new main main@upstream -m "merge: sync upstream main"`.
- Resolve any merge conflicts in that sync change. Do not mix feature work or unrelated edits into the upstream sync merge.
- When a fork feature or fix conflicts with an equivalent upstream feature or fix, prefer the upstream version
  unless the fork still has documented requirements that upstream does not satisfy.
- For large upstream merge conflicts, delegate the conflict investigation and resolution work to a subagent so the main agent's context stays focused. Have the subagent inspect the conflicted files, identify upstream/local intent, resolve the conflicts, and report the exact files and strategy used. The main agent must wait for the subagent to finish before reviewing the completed resolution, running checks, and committing the sync merge.
- After resolving conflicts, run the required checks, then commit the sync change with `jj commit -m "merge: sync upstream main"`.
- Do not use `jj-pull main --remote upstream` for routine fork syncing; that moves/rebases `main` to upstream instead of preserving the fork's merge-based history.
- When work is done, commit the intended changes and push directly to `main` with `jj-push main` instead of opening a pull request.
