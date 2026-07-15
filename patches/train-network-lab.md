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
- Scenario steps are either adapter actions or observed checkpoints with explicit timeouts. There is
  intentionally no sleep step: progress must be driven by observable system state.
- A deterministic xorshift32 stream assigns a decision token to each planned step. The same scenario,
  profile, and seed produce the same identity, order, and tokens; later fault adapters can consume
  those tokens without inventing their own nondeterministic selection.
- Profiles describe only the client-facing path. The origin path is the literal `unshaped`, making it
  impossible to represent server/provider shaping in a valid version-1 profile.
- The runner accepts a compiled plan and a narrow adapter. The adapter can prepare resources, execute
  a namespaced action, observe a named checkpoint, collect correctness and fault proof, and clean up.
  It does not expose or prescribe server, provider, browser, proxy, relay, namespace, or `tc` types.
- Result schema version 1 always contains correctness, fault, and cleanup sections. Preparation,
  execution, evidence collection, and cleanup errors are converted to structured evidence; a failed
  run resolves to a machine-readable result instead of rejecting.
- Passing requires successful execution, passing correctness and fault evidence, explicit proof that
  the origin path remained unshaped, and passing cleanup evidence.

## Maintenance and extension seams

- The Linux packet should implement the adapter behind a client-facing ingress and translate plan
  decision tokens into deterministic `tc netem` or proxy settings. It must populate fault events and
  attest that the upstream/origin-facing path has no qdisc.
- The server/provider fixture should surface observed checkpoint names and correctness assertions;
  it must not become a shaping surface.
- The browser packet should drive production web behavior through namespaced actions and DOM-visible
  checkpoints. Browser timing belongs in evidence details, not in scenario control flow.
- Protocol-aware acknowledgement loss should remain a dedicated adapter component because ordinary
  TCP packet loss is retransmitted and cannot prove lost-response recovery.
- A future comparator may add a separately versioned aggregate artifact. It must match results by
  scenario/profile/seed identity before comparing timing or traffic metrics.

## Verification

Focused coverage validates schema boundaries, deterministic planning, checkpoint-driven execution,
failure evidence, and cleanup behavior:

```bash
nix develop --command ./node_modules/.bin/vp test run scripts/network-lab
nix develop --command ./node_modules/.bin/vp run --filter @t3tools/scripts typecheck
```

Repository gates remain `vp check` and `vp run typecheck` from the Nix development shell.
