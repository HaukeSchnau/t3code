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

Parallel read-only exploration and dependency-aware packet design.

## Completed

- Analyzed 30 historical upstream-sync merges and identified concentrated conflict hotspots.
- Synced fork `main` with upstream through `1a003e383ac6` in a dedicated clean merge.
- Verified the upstream usage-dashboard change with mobile, web, and shared typechecks plus 18 focused tests.
- Recorded the current implementation baseline: provider ingestion, projection reads, `ws.ts`, and `ChatView`
  are the highest-value active conflict surfaces; the old Sidebar divergence is retired.

## Remaining work

- Synthesize explorer findings into non-overlapping work packets.
- Implement and verify each packet as an atomic JJ change.
- Run integrated React diagnostics, focused package checks, and conflict-surface measurements.
- Update the relevant `patches/*.md` maintenance notes and this plan.

## Verification status

- Upstream synchronization: clean merge.
- Affected upstream packages: typechecks passed.
- Shared/web usage tests: 18 passed.
- Repository working checks for refactor packets: pending.

## Environment constraint

The repository flake development shell currently hits Nix-store hard-link saturation while copying the
source. Use `nix shell nixpkgs#nodejs_24` with the local `node_modules/.bin/vp` for focused checks until the
store issue is repaired. Dependencies were installed from the frozen lockfile with lifecycle scripts disabled;
tests and typechecks used no native runtime modules.

## Follow-up tasks

- Measure the active fork delta and repeated merge-footprint paths after integration.
- Reassess remaining general-purpose fork patches for upstreaming or retirement.
