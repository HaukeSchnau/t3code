# Fork conflict reduction

## Active goal

Reduce recurring upstream-sync conflicts by moving fork behavior out of upstream-owned convergence files,
retiring overlap when upstream is authoritative, and making derived merge work deterministic.

## Scope

- Deepen provider runtime ingestion internals without changing its lifecycle interface.
- Split projection reads by domain purpose while preserving RPC and test compatibility.
- Move orchestration workflows out of the WebSocket transport adapter.
- Deepen web thread interaction and mobile route presentation modules.
- Automate lockfile regeneration and upstream-sync conflict reporting.
- Preserve all existing web, mobile, server, provider, and remote behavior.

## Workstreams

1. Provider runtime ingestion
2. Projection reads
3. WebSocket transport
4. Web thread interaction
5. Mobile route presentation
6. Fork synchronization tooling and documentation

## Current step

Implementation and focused verification are complete. Record the React Doctor workspace limitation, inspect
the outbound stack, then move and push `main`.

## Completed

- Analyzed 30 historical upstream-sync merges and identified concentrated conflict hotspots.
- Synced fork `main` with upstream through `1a003e383ac6` in a dedicated clean merge.
- Verified the upstream usage-dashboard change with mobile, web, and shared typechecks plus 18 focused tests.
- Recorded the current implementation baseline: provider ingestion, projection reads, `ws.ts`, and `ChatView`
  are the highest-value active conflict surfaces; the old Sidebar divergence is retired.
- Completed intent maps and invariant audits for provider ingestion, projection/transport, web/mobile,
  and fork-sync tooling.
- Localized mobile pending-route presentation and moved composer/request state into the conversation surface.
- Added deterministic lockfile regeneration/checking and read-only JJ reconciliation reporting; refreshed the
  two stale canonical-lock peer metadata entries and verified the deploy lock remains current.
- Isolated web historical-turn hydration and Codex message forking from `ChatView`.
- Split projection operational, activity/history, search/count, and row-mapping reads behind the unchanged
  facade, reducing `ProjectionSnapshotQuery.ts` by 766 lines.
- Extracted provider subagent, runtime-event ledger, usage-limit, and observed-media policy, reducing
  `ProviderRuntimeIngestion.ts` by 1,057 lines before the journal packet.
- Extracted transcript-journal recovery, delivery, batching, acknowledgement, tombstone, and buffered-promotion
  policy; hard-kill recovery and ordinary subagent coalescing both pass.
- Extracted subscription/replay, durable command dispatch, and Codex resume/fork workflows from `ws.ts` while
  preserving public RPCs, receipts, cursor/pagination contracts, cleanup, and relationship activities.
- Centralized web thread submission for Chat and Monitor, including revision-aware optimistic lifecycle and
  failure restoration.
- Centralized durable outbox/queued controls and reduced the previous-message editing boundary from 51 inputs
  to 12, while retaining server-authoritative Monitor behavior.
- Added five direct Codex RPC workflow tests for validation, cleanup, and best-effort activity behavior.
- Documented the stable server/client ownership boundaries in `patches/conflict-reduction-boundaries.md` and
  updated affected patch notes.

## Remaining work

- Inspect the outbound stack, move `main`, and push it to the fork.

## Verification status

- Upstream synchronization: clean merge.
- Affected upstream packages: typechecks passed.
- Shared/web usage tests: 18 passed.
- Server integrated typecheck: passed after all server packets.
- Server focused packet checks: projection 30; ingestion 65 plus recovery/ledger/media subsets; subscription
  and replay 37; command dispatch 38; Codex bridge/home/importer/WebSocket 39.
- Web phase-one checks: typecheck passed; submission/hydration/forking suites passed.
- Mobile checks: typecheck passed; pending navigation and outbox suites passed.
- Final web: typecheck passed; 56 directly impacted tests passed in the integrator rerun and 81 in the packet
  owner's broader focused suite; scoped lint and format passed.
- Mobile: typecheck and 41 pending-navigation/edit/outbox/drain tests passed.
- Fork tooling: 9 tests and scripts typecheck passed; canonical lockfile determinism and deploy-lock checks pass.
- Server: integrated typecheck passes; direct Codex workflow tests pass 5/5.
- Reconciliation report: 30 historical sync merges; the top repeated paths remain `pnpm-lock.yaml` (15),
  `ChatView.tsx` (13), `ws.ts` (8), `MonitorView.tsx` (6), `ThreadRouteScreen.tsx` (4),
  `ProjectionSnapshotQuery.ts` (4), and `ProviderRuntimeIngestion.ts` (4).
- React Doctor: could not inspect the linked JJ workspace because it has no workspace-local `.git`; the
  required diff scan fell back to a prohibited full scan and was cancelled. Explicit `--base` retries cannot
  resolve Git refs from this workspace. Focused typecheck, lint, format, and tests remain the React proof.

## Conflict-surface measurements

- `apps/server/src/ws.ts`: 3,358 -> 1,458 (-1,900, 56.6%).
- `ProviderRuntimeIngestion.ts`: 3,734 -> 2,431 (-1,303, 34.9%).
- `ProjectionSnapshotQuery.ts`: 3,570 -> 2,804 (-766, 21.5%).
- `ChatView.tsx`: 7,064 task baseline -> 6,571 (-493, 7.0%); 6,896 pre-web-packets ->
  6,571 (-325, 4.7%).
- `MonitorView.tsx`: 1,509 -> 1,486 (-23, 1.5%) while removing parallel submission/control policy.
- Mobile `ThreadRouteScreen.tsx`: 950 -> 845 (-105, 11.1%).

## Environment constraint

The repository flake development shell currently hits Nix-store hard-link saturation while copying the
source. Use `nix shell nixpkgs#nodejs_24` with the local `node_modules/.bin/vp` for focused checks until the
store issue is repaired. Dependencies were installed from the frozen lockfile with lifecycle scripts disabled;
tests and typechecks used no native runtime modules.

## Follow-up tasks

- Measure the active fork delta and repeated merge-footprint paths after integration.
- Reassess remaining general-purpose fork patches for upstreaming or retirement.
