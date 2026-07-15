# Deterministic Network Lab Foundation

## Purpose

This fork needs repeatable evidence for connection recovery over intermittent mobile links. The
foundation under `scripts/network-lab/` defines the stable scenario, profile, execution-plan, result,
and adapter boundaries used by later Linux impairment, managed-relay, and real-browser packets. NL1
adds the first direct server/provider recovery adapter without changing those production contracts.

## Contract

- Scenario and profile documents use schema version 1. Their identities are separate versioned
  values, and every execution identity records the scenario, profile, unsigned 32-bit seed, stable
  definition hash, and human-readable execution ID.
- Scenario steps separate application/browser actions, network fault controls, and observed
  checkpoints with explicit timeouts. There is intentionally no sleep step: progress must be driven
  by observable system state. Compilation rejects scenarios without at least one fault control, and
  the runner cannot pass a forged zero-control plan.
- Fault controls are a schema-versioned discriminated union. Version 1 models administrative link
  offline/apply and online/remove, directional data-plane blackhole apply/remove, active-connection
  reset, directional impairment, and protocol-aware acknowledgement/response suppression. Every
  control states its surface, direction, lifecycle, and semantics. Impairment semantics define
  latency as constant one-way delay and jitter as a uniform plus-or-minus delay whose resulting
  sample is clamped at zero. Loss is independent per-packet probability. A numeric bandwidth is the
  maximum throughput in kilobits per second; `null` means unlimited throughput with no rate limit.
  The same semantic object is mandatory on profiles and directional controls, so adapters cannot
  interpret baseline and step-applied impairment differently.
- A deterministic xorshift32 stream assigns a decision token to each planned step. The same scenario,
  profile, seed, lab provenance, and adapter provenance produce the same identity, order, and tokens;
  later fault adapters can consume those tokens without inventing their own nondeterministic
  selection. Definition hashing canonicalizes object keys by JavaScript code-unit order rather than
  locale collation and includes the complete version-1 control semantics and provenance.
- Profiles describe only the client-facing path. The origin path is the literal `unshaped`, making it
  impossible to represent server/provider shaping in a valid version-1 profile.
- The runner accepts a compiled plan and a narrow adapter. Preparation returns a nonempty resource
  lease whose manifest is then owned by the runner. The adapter can execute an application action or
  typed fault control, observe a named checkpoint, collect correctness and fault proof, and release
  one registered resource at a time. It does not expose or prescribe server, provider, browser,
  proxy, relay, namespace, or `tc` types.
- Every adapter operation receives an `AbortSignal` and is bounded by a runner deadline. Cleanup runs
  in guaranteed finalization, receives its own deadline even when execution was aborted, attempts
  every registered resource, and retains per-resource success, failure details, and structured
  runner errors.
- Result schema version 1 always contains correctness, fault, and cleanup sections. Preparation,
  execution, evidence collection, and cleanup errors are converted to structured evidence; a failed
  run resolves to a machine-readable result instead of rejecting.
- Public result decoding is fail closed through status-discriminated schemas. Passed correctness
  requires at least one passing assertion, passed fault evidence requires at least one typed
  operation and an unshaped origin path, and passed cleanup requires a lease plus at least one
  released resource without an error. A passed top-level result requires all three passed evidence
  variants and an empty runner-error tuple; forged contradictory results fail schema decoding.
- Passing requires successful execution; a nonempty set of uniquely named, passing correctness
  assertions; and exact fault evidence for every planned control in plan order. Each fault operation
  must match its step ID, sequence, decision token, kind, surface/direction, lifecycle, and effective
  parameters. Passing also requires explicit proof that the origin path remained unshaped and
  nonempty cleanup proof for every uniquely registered resource. Empty, duplicate, reordered,
  wrong-kind, mismatched, or partially failing evidence cannot produce a passing result.

## Maintenance and extension seams

- A later Linux packet may implement the adapter behind a client-facing ingress and translate plan
  controls and decision tokens into deterministic impairment settings. It must populate typed fault
  operations and attest that the upstream/origin-facing path is unshaped. No Linux, `tc`/netem,
  proxy, browser, or server adapter is part of this foundation.
- The server/provider fixture should surface observed checkpoint names and correctness assertions;
  it must not become a shaping surface.
- The browser packet should drive production web behavior through application actions and DOM-visible
  checkpoints. Browser timing belongs in evidence details, not in scenario control flow.
- Protocol-aware acknowledgement loss should remain a dedicated adapter component because ordinary
  TCP packet loss is retransmitted and cannot prove lost-response recovery.
- A future comparator may add a separately versioned aggregate artifact. It must match results by
  scenario/profile/seed identity before comparing timing or traffic metrics.

## NL1 direct Effect RPC recovery gate

NL1 owns `apps/server/integration/NetworkRecoveryHarness.integration.ts` and
`apps/server/integration/networkRecovery.integration.test.ts`, with read-only observation seams in
the existing orchestration and deterministic-provider harnesses. It launches a real Node WebSocket
server with the Effect RPC dispatch schema, calls the real orchestration engine and receipt store,
and lets the deterministic provider adapter complete a turn. The version-1 profile still declares
the origin path `unshaped`; no control is installed on the server or provider side.

The loss gate decorates only the client socket. It records the outgoing Effect RPC request, then
examines origin-to-client frames. A successful terminal `Exit` is eligible for suppression only when
its request id correlates to the captured command and an independent receipt read proves an accepted
`thread.turn.start` with a nonempty envelope fingerprint and the same positive result sequence. The
gate does not suppress `Ack`, errors, uncorrelated exits, or any frame when receipt proof is
unavailable. On a proved match it suppresses exactly that complete `Exit` and closes only the client
link. Retry creates a new RPC protocol/session and sends the same frozen client envelope and command
id.

Passing evidence requires one terminal receipt, the single expected command-event set, one provider
send, one provider turn, and one projected user/assistant turn. It also requires identical canonical
envelope hashes across retry, replay of the committed receipt sequence, and semantic projection/hash
equality with a no-fault oracle. The false-green case deliberately makes receipt proof unavailable:
the real adapter forwards the terminal exit and correctness remains intact, but fault evidence must
fail. Repeating the recovery plan with the same seed must reproduce the normalized control
transcript. Cleanup is runner-bounded per resource and a second cleanup pass proves every release is
idempotent.

NL1 is deliberately attachment- and bootstrap-free. RC2 owns client-command preprocessing,
deterministic attachment persistence/identity, and first-send worktree bootstrap replay. Repeating
those cases here would obscure whether failure came from preprocessing or acknowledgement loss.
NL2 will reuse the NL1 scenario/profile/provenance and correctness oracle while replacing the direct
client action with Chromium production UI behavior and DOM-visible reconnect checkpoints; the
server/provider recovery fixture remains the unshaped downstream oracle rather than becoming a
browser-specific fault surface.

## NL2 Chromium measurement and comparison gate

NL2 adds a version-1 browser measurement artifact and comparator under `scripts/network-lab/`.
Measurements retain the compiled run identity and record durable local acceptance samples,
DOM-visible connection-status samples, recovery latency, exactly-once command/effect counts,
semantic and replay hashes, cached-content visibility, deterministic fault tokens, traffic counters,
and explicit fault/cleanup proof. The comparator refuses mismatched identities or non-reproducible
candidate fault sequences. Correctness is absolute; the CI thresholds require offline acceptance at
or below 150 ms p95 and connection feedback at or below 300 ms p95. Recovery and traffic use
versioned relative ceilings with fixed allowances so small baseline values do not create unstable
ratios.

`browser-runner.ts` is the executable, fail-closed orchestration seam. Given a compiled direct plan
and browser-ready baseline/candidate fixtures, it navigates the production T3 URL, verifies the real
composer and cached-timeline surfaces, submits via the production send button, waits for the durable
outbox strip, executes reload steps, applies each typed control with its planned decision token,
waits for the production connection status and recovery, collects the NL1 oracle, and proves browser
and fixture cleanup. The comparison gate runs baseline, candidate, and a second candidate with the
same plan/seed, then throws if any threshold or correctness assertion fails. The direct matrix covers
clean, poor, blackhole, flap/handover, reload, and lost acknowledgement; hosted relay remains
non-gating.

The pinned Playwright-core driver lives beside the desktop browser runtime. It launches a real
Chromium persistent context with an isolated temporary profile, applies client-only CDP network
conditions, measures HTTP/WebSocket traffic, drives production selectors, and proves browser/profile
cleanup. Protocol suppression is deliberately not emulated by CDP: it must be delegated to the real
NL1 server fixture, and missing delegation fails before recording fault evidence.

There is currently no repository fixture that serves both the complete authenticated T3 web app and
the deterministic NL1 provider/RPC state. NL1 serves an Effect-RPC-only WebSocket endpoint, which is
not enough for `ChatView` to load an active thread. Consequently the production runner is callable
and contract-tested, while the checked real-Chromium smoke proves CDP shaping, traffic collection,
DOM timing, and process/port/profile cleanup against an ephemeral page. That smoke is not claimed as
end-to-end production UX evidence. A future fixture must compose the normal server HTTP/web/auth
routes with the NL1 deterministic provider before the six-scenario production matrix can become a
gating CI command.

## Verification

Focused coverage validates control schema boundaries, locale-independent golden planning,
checkpoint-driven execution, strict evidence matching, aborting hung collectors, and partial cleanup
failure behavior. NL1 adds the direct real-RPC recovery and false-green cases:

```bash
nix develop --command ./node_modules/.bin/vp test run scripts/network-lab
nix develop --command ./node_modules/.bin/vp run --filter @t3tools/scripts typecheck
./node_modules/.bin/vp test run apps/server/integration/networkRecovery.integration.test.ts
./node_modules/.bin/vp run --filter t3 typecheck
./node_modules/.bin/vp test run scripts/network-lab
T3_NETWORK_LAB_CHROMIUM=/path/to/chromium ./node_modules/.bin/vp test run \
  apps/desktop/src/network-lab/ChromiumNetworkLabHarness.test.ts
./node_modules/.bin/vp run --filter @t3tools/scripts --filter @t3tools/desktop typecheck
```

Repository gates remain `vp check` and `vp run typecheck` from the Nix development shell.
