# Deterministic Network Lab Foundation

## Purpose

This fork needs repeatable evidence for connection recovery over intermittent mobile links. The
foundation under `scripts/network-lab/` defines the stable scenario, profile, execution-plan, result,
and adapter boundaries that later Linux impairment, server fixture, managed-relay, and real-browser
packets will implement.

No network, browser, provider, or server implementation is included in this patch. The module is a
test and diagnostics foundation only.

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

## Verification

Focused coverage validates control schema boundaries, locale-independent golden planning,
checkpoint-driven execution, strict evidence matching, aborting hung collectors, and partial cleanup
failure behavior:

```bash
nix develop --command ./node_modules/.bin/vp test run scripts/network-lab
nix develop --command ./node_modules/.bin/vp run --filter @t3tools/scripts typecheck
```

Repository gates remain `vp check` and `vp run typecheck` from the Nix development shell.
