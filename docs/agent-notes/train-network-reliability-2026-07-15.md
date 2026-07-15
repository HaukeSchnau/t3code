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

### NL2 browser comparator status

- Implemented a versioned browser measurement/comparator and a direct six-scenario readiness matrix.
  The matrix is explicitly blocked/non-gating until the browser-ready deterministic T3 fixture
  exists; the baseline/candidate/repeat runner contract fails the command on
  identity, reproducibility, correctness, latency, traffic, fault-proof, or cleanup regressions.
- Implemented a pinned Playwright-core Chromium driver with real client-path CDP controls,
  HTTP/WebSocket traffic accounting, new-command-correlated composer/outbox interactions, explicit
  status/recovery checkpoints, and isolated process/profile cleanup proof. Real Chromium smoke passes when
  `T3_NETWORK_LAB_CHROMIUM=/run/current-system/sw/bin/chromium` is supplied.
- Remaining integration blocker: NL1 exposes Effect RPC but not a browser-ready authenticated T3
  app with an active deterministic thread. The full production six-profile run needs a fixture that
  composes the standard HTTP/web/auth routes with NL1's provider/oracle and suppression control.

## Current State

- 2026-07-15: fetched origin/upstream, merged `main@upstream` at `ecb35f758399` without conflicts.
- Baseline `vp check` passed with 10 existing React warnings.
- Baseline full typecheck passed.
- Explorer threads completed for outbox, network lab, and UX/transport decomposition.
- Wave 1 integrated as four atomic changes: shared durable outbox, accepted-receipt preservation,
  single-owner liveness coverage, and the deterministic network-lab foundation.
- Wave 1 review corrections are integrated. The outbox now publishes persistence and in-memory
  transitions interruption-safely; receipt replay verifies immutable command envelopes and survives
  migration, concurrency, rollback, and restart; liveness tests exercise the installed Effect pinger
  through the real supervisor boundary; and the network lab fails closed on unverifiable fault and
  cleanup evidence.
- Independent re-review approved the outbox, liveness, network-lab, and receipt corrections. The
  replacement receipt reviewer confirmed that the added tests traverse the real repository decoder
  and dispose/reopen SQLite after finalization rollback.
- Final integrated Wave 1 verification passed: 9 focused files / 94 tests and `vp check` with the 10
  baseline React warnings. Full workspace typecheck exposed one raw timer in the network-lab runner;
  it was replaced by an abortable `Effect.sleep` deadline, its 16 focused tests passed, and the full
  15-workspace typecheck then passed with only baseline Effect suggestions.
- Wave 2 preflight found two server-side replay blockers before platform integration: upload
  normalization generates random attachment IDs before receipt fingerprinting, and bootstrap-bearing
  turn starts execute newly identified bootstrap subcommands before the original receipt is observed.
  Packet `RC2` now owns replay-safe preprocessing and must close both before image/bootstrap commands
  enter web or mobile durable storage.
- Mobile preflight also found that lossless legacy edit/delete behavior needs reviewed Pending-only
  replace/cancel transitions in the shared core; platform code must not mutate storage behind the
  lifecycle service. Web preflight will initially prefer `thread.message.queue` for ordinary existing
  threads and keeps destructive, bootstrap, approval, interrupt, VCS, terminal, and preview workflows
  outside generic replay.
- `UX1` is integrated and independently approved after correction: disconnected transport now
  downgrades nominally live content, content snapshot sequence is not mislabeled as a replay cursor,
  and the projection rejects contradictory source combinations.
- Pending-only outbox edit/cancel transitions are integrated and independently approved. Every edit
  rotates the command identity, so a drainer holding stale ready entry A cannot begin it after
  replacement B is published; adapters must dispatch only the canonical frozen plan returned by
  `begin`. Central verification passed 25 focused tests.
- Initial `RC2` preprocessing review approved deterministic attachment identity and post-commit
  materialization ordering but rejected three remaining gaps: project filesystem effects before
  receipt/lock, bootstrap's pre-receipt crash window, and route-local rather than process-scoped
  command serialization. Correction `wsowspmkxryy` is integrated: a process-scoped preprocessing
  coordinator persists deterministic bootstrap progress, defers filesystem work behind receipt
  resolution/serialization, reconciles interrupted workspace creation, and publishes attachments
  atomically. Central verification passed 5 focused server files / 147 tests and scoped server
  typecheck; independent correction review is still required before platform rollout.
- `NL1` is integrated and independently approved. Its real Effect RPC fixture suppresses only the
  response after receipt proof, reconnects with a fresh session, verifies exactly one durable effect
  and projection, compares the final oracle hash, and bounds cleanup. Central focused verification
  passed 18 tests.
- The Wave 3 UX experiment completed. Its implementation target exposes four independent facts:
  transport state, data freshness, locally durable intent state, and remote queue state. It specifies
  exact wording and actions for 15 clean/degraded states, Pending-only edit/cancel, accessible live
  regions, reduced motion, 250/500 ms anti-flicker holds, and screenshot review across desktop,
  narrow web, iOS, and Android. UX2/UX3 must consume the shared OB2/OB3 lifecycle rather than decorate
  the existing web in-memory optimism or mobile legacy retry loop.
- `RC2` is now independently approved after several adversarial correction rounds. Bootstrap
  preprocessing is process-scoped and crash-resumable; attachment/workspace effects are deterministic;
  setup completion is journal-backed; HTTP cannot bypass bootstrap preprocessing; and the fresh-server
  WebSocket gate rebuilds listeners and service graphs over the same SQLite database. The final review
  found and closed a high-severity script-identity hole: preprocessing now atomically freezes the setup
  execution key/digest, so changing project script A to B after A claims fails before filesystem or
  terminal I/O. Restoring A reconciles its original journal and dispatches the turn exactly once.
- `OB2` mobile and `OB3` web implementations are integrated as separate changes and are under separate
  independent reviews. Mobile focused verification passed 16 tests, TypeScript, and the mobile static
  check; web focused verification passed 34 tests, typecheck, and scoped formatting/lint. Both still
  require reviewer approval and real degraded-network interaction validation.
- The product-native durable-thread API began returning `Auth required`, so later implementation and
  review packets use visible lightweight subagents until T3 thread orchestration is available again.
- Current step: complete independent `OB2`/`OB3` review, implement `UX2`/`UX3`, then run the real-browser
  comparator, mobile/browser screenshot review, integrated regression suite, and final repository gates.

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
- Outbox correction re-review: `mcp:thread:59f58211-e76b-46ed-8e72-f37df812fd0c`
- Liveness correction re-review: `mcp:thread:0f9c7599-1553-4921-8422-9c4b3bbd5306`
- Network-lab final re-review: `mcp:thread:22e9fada-5636-4512-bc7c-bfd2d3a69143`
- Receipt correction review: `mcp:thread:a11288d3-1354-407a-9a94-2ccd804521ab`
- Receipt correction implementation: `mcp:thread:53bfceeb-9b8b-4758-8158-229146f0c017`
- Receipt replacement review: `mcp:thread:2939be74-3428-40eb-8a24-eeaa445b4f49`

## Wave 2 Threads

- Mobile outbox preflight/implementation: `mcp:thread:31c73ee7-47f4-488c-bfee-c8477be4b59e`
- Web outbox preflight/implementation: `mcp:thread:4c4de5be-6e36-481b-87c4-45c6190b4934`
- Shared connection/freshness projection: `mcp:thread:eecca459-bc8b-425f-ac42-2a4afc0da591`
- Replay-safe server preprocessing: `mcp:thread:289fd42e-9530-4170-973d-692646648ff5`
- Connection/freshness review: `mcp:thread:24838132-85b4-4336-a595-26fc94f981ef`
- Pending outbox lifecycle implementation: `mcp:thread:1e89825d-06bd-4aa1-9b61-be05d4a7e8b2`
- Pending outbox lifecycle review: `mcp:thread:2edb4303-57a1-44df-8ec3-8dce17c3bec3`
- Replay-safe preprocessing review: `mcp:thread:4ec7b446-3100-4b0d-a472-1953ed3e7a67`
- Real acknowledgement-loss fixture: `mcp:thread:a7b0976c-9169-423e-9034-ebb68af72c2b`
- Crash-resumable preprocessing correction review: `mcp:thread:edbd43d3-f8b8-4032-b63b-8bdf2aee9bc0`
- Train-state UX experiment: `mcp:thread:d2e4b0ca-9ee3-4ac0-a469-021e2b4f695d`

## Verification Notes

Run authoritative commands through `nix develop` and the workspace-local `./node_modules/.bin/vp`.
The ambient shell does not provide a global `vp`, and package-manager fallback can drift the lockfile.
