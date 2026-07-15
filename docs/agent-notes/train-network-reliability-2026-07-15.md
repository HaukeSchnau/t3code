# Train-Network Reliability Program

## Goal

Make T3 Code materially useful over intermittent, high-latency mobile links while the remote
environment continues working independently. Prove the improvement with deterministic fault
injection, independent review, real-browser validation, and the repository's full safety gates.

## Scope

- A versioned poor-network lab covering link-state changes, latency/loss/bandwidth, data-plane
  blackholes, socket resets, and protocol-aware lost acknowledgements.
- A shared, durable client command outbox used by web and mobile for explicitly audited thread
  operations.
- Consistent connection, freshness, retry, and queued-message presentation across clients.
- Liveness and replay instrumentation before changing transport policy or replay thresholds.
- Direct remote and deterministic managed-relay paths; live hosted-relay runs remain non-gating.

## Invariants

- `EnvironmentSupervisor` remains the only transport reconnect owner.
- Effect RPC transport retries remain disabled; durable subscriptions follow replacement sessions.
- A durable outbox item freezes its command variant and payload before first network IO.
- Ambiguous/transient retries reuse the same command ID; edit-and-retry after rejection mints a new
  identity.
- Per-thread FIFO is preserved. A permanently failed head blocks only its own thread.
- Cached snapshots remain paired with their sequence cursor and visible through reconnects.
- Replay keeps the live-before-history ordering and client sequence deduplication.
- No generic offline replay for approvals, interrupts, VCS operations, terminal input, preview
  automation, or arbitrary RPC calls.

## Work Graph

### Wave 1 — Independent foundations

| ID    | Objective                                                                    | Ownership                                                              | Dependencies |
| ----- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------ |
| `NL0` | Versioned scenario/result model and minimal deterministic network-lab runner | `scripts/network-lab/**`, focused root/package scripts                 | none         |
| `OB1` | Shared durable outbox core with immutable delivery plans and lifecycle tests | new client-runtime outbox modules, operations/platform exports         | none         |
| `LC1` | Lock in existing RPC ping/pong and single-session liveness behavior          | client-runtime RPC session and focused patch doc                       | none         |
| `RC1` | Add receipt/idempotency regression coverage for turn start and server queue  | orchestration engine tests; production only if a test exposes a defect | none         |

### Wave 2 — Platform integration

| ID    | Objective                                                                  | Ownership                                                             | Dependencies |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------ |
| `OB2` | Migrate mobile to shared outbox without losing legacy records or behavior  | mobile thread-outbox state, storage, drain, and tests                 | `OB1`, `RC1` |
| `OB3` | Add IndexedDB-backed web outbox and offline composer submission            | web storage, focused send-intent/outbox modules, composer integration | `OB1`, `RC1` |
| `UX1` | Shared connection/freshness projection with stage, attempt, and retry time | client-runtime connection/state presentation                          | `LC1`        |
| `NL1` | Real server/provider fixture and protocol-aware acknowledgement-loss gate  | server integration network-recovery fixture/tests                     | `NL0`, `RC1` |

### Wave 3 — Experience and measurement

| ID    | Objective                                                                             | Ownership                                                | Dependencies        |
| ----- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------- |
| `UX2` | Web cached/offline/queued/loading experience                                          | web chat presentation and tests                          | `OB3`, `UX1`        |
| `UX3` | Mobile queued-item recovery and connection/freshness experience                       | mobile thread/connection presentation and tests          | `OB2`, `UX1`        |
| `NL2` | Real Chromium scenario, baseline/candidate comparator, CI-sized direct matrix         | web browser test entry and network-lab runner/comparator | `NL1`, `OB3`, `UX2` |
| `RP1` | Replay metrics: tail, pages, scanned/emitted events, duration, buffer high-water mark | server replay and workload diagnostics                   | `NL1`               |

### Wave 4 — Evidence-driven hardening

- Run baseline/candidate scenarios for clean, poor, blackhole, flap, handover, reload, and lost ack.
- Select replay fallback/bounds only if `RP1` and the lab demonstrate excessive catch-up work.
- Select retry jitter or ping timing changes only if multi-environment or false-positive measurements
  justify them.
- Add deterministic managed-relay topology after the direct vertical scenario is stable.

## Independent Review Graph

- `REV-O`: outbox correctness, immutable commands, migrations, FIFO, permanent failures.
- `REV-N`: lab fidelity, fault proof, cleanup, result reproducibility, server remains unshaped.
- `REV-T`: retry ownership, liveness, replay correctness, cached cursor/state coupling.
- `REV-U`: screenshot-first web/mobile UX review under clean and poor profiles.
- `TEST-I`: integrated regression tester; did not implement any packet.

Reviewer findings return to the owning implementer as a bounded correction turn, then are reviewed
again. Implementers do not approve their own packets.

## Acceptance Gates

- Zero lost commands and exactly one durable logical effect per command ID across repeated fault
  cycles.
- Final client state/replay hash matches the no-fault oracle.
- Offline submit is durably visible within 150 ms p95 and survives reload/process loss.
- Cached content never blanks during reconnect; initial loaders appear only without cached content.
- Connection/freshness changes are visibly explained within 300 ms.
- A silent peer is detected within the documented Effect ping/pong envelope without a second
  transport retry owner.
- Same scenario/profile/seed reproduces the same fault sequence and correctness counts.
- No leaked child process, namespace, qdisc, route, socket, port, or temporary directory.
- Candidate recovery latency and traffic stay within the versioned comparator thresholds; correctness
  gates are absolute.
- `vp check`, `vp run typecheck`, `vp run lint:mobile`, focused packet tests, and the integrated test
  suite pass in the Node 24 Nix development shell.

## Current State

- 2026-07-15: fetched origin/upstream, merged `main@upstream` at `ecb35f758399` without conflicts.
- Baseline `vp check` passed with 10 existing React warnings.
- Baseline full typecheck passed.
- Explorer threads completed for outbox, network lab, and UX/transport decomposition.
- Wave 1 integrated as four atomic changes: shared durable outbox, accepted-receipt preservation,
  single-owner liveness coverage, and the deterministic network-lab foundation.
- Integrated Wave 1 verification passed: 8 focused files / 76 tests, full `vp check` with the 10
  baseline React warnings, and full workspace typecheck with only baseline Effect suggestions.
- `REV-N` found blocking lab-model issues: opaque fault classes, false-green evidence, insufficient
  cleanup guarantees, and locale-dependent identity. It also requested a less brittle liveness test
  and a precise public timeout envelope. Correction packets `NL0-R1` and `LC1-R1` are active.
- The documentation formatting gate identified by `REV-N` was resolved atomically and full
  `vp check` was rerun successfully.
- `REV-O` is independently reviewing the outbox/receipt interaction before platform integration.
- Current step: close Wave 1 review findings, rerun integrated gates, then start Wave 2 packets from
  the reviewed foundation.

## Explorer Threads

- Outbox: `mcp:thread:aad8a427-6be3-4741-a542-acda61122b12`
- Network lab: `mcp:thread:c4052884-986d-41c1-81c0-d47c089e6243`
- UX/transport: `mcp:thread:8b9da51c-62df-4fc5-bccb-bcb84fc65a00`

## Wave 1 Threads

- Network-lab implementation: `mcp:thread:50e9de5c-9774-46f0-b995-1703436f4c08`
- Shared outbox implementation: `mcp:thread:6248f5cc-0b63-4b51-935d-49fed9647450`
- Liveness implementation: `mcp:thread:8e48536d-9381-41a2-a025-72ad19129c4e`
- Receipt implementation: `mcp:thread:f4d1341a-2eb7-4bfc-a866-288b264e524a`
- Network/liveness review: `mcp:thread:9be9da98-b438-4a72-a9bb-154aadddcf36`
- Outbox/receipt review: `mcp:thread:ed8af283-eaa5-4354-8d78-7402ca9fc892`
- Network-lab correction: `mcp:thread:577e75b3-0e7c-4dbd-bba5-7f9b81364617`
- Liveness correction: `mcp:thread:ea5a2a60-e965-4124-9d7e-ca21197106c2`

## Verification Notes

Run authoritative commands through `nix develop` and the workspace-local `./node_modules/.bin/vp`.
The ambient shell does not provide a global `vp`, and package-manager fallback can drift the lockfile.
