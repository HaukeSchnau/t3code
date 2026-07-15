# RPC Session Liveness

## Goal

Keep each client-runtime RPC session bounded to one scoped WebSocket while relying on Effect RPC's
built-in ping/pong liveness. `EnvironmentSupervisor` remains the only component that decides when to
reconnect.

## Contract

- `RpcSessionFactory.connect` constructs one WebSocket for one scoped session attempt.
- Effect RPC sends its built-in ping and requires a pong. A missed pong fails the protocol, closes
  the scoped WebSocket, and resolves `RpcSession.closed` with a transient transport error.
- The session protocol uses `retryTransientErrors: false` and `Schedule.recurs(0)`. It never creates a
  replacement WebSocket internally; `EnvironmentSupervisor` observes `RpcSession.closed`, releases
  the failed lease, applies backoff, and owns any later connection attempt.
- The WebSocket open timeout and supervisor setup/foreground-probe timeouts remain 15 seconds. This
  patch does not introduce another heartbeat, reconnect loop, or timing policy.

## Verification Seam

`packages/client-runtime/src/rpc/session.test.ts` uses a deterministic test clock and fake WebSocket at
the public transport boundary. The test observes an encoded Effect RPC `Ping`, replies with `Pong`,
then withholds the next pong and verifies that the session closes with exactly one constructed socket.
This proves the application-visible liveness and ownership contract without importing Effect RPC
internals.

The test advances Effect's current five-second ping cadence because the dependency does not expose a
pinger configuration or test service. That timing is dependency-owned, not a client-runtime policy;
the test intentionally avoids duplicating it in production code. On Effect upgrades, review
`patches/effect@4.0.0-beta.78.patch` and this transport-boundary test together.

Existing supervisor tests separately verify that an involuntary session close causes a supervised
reconnect, and that stalled connection setup and foreground probes retain their 15-second boundaries.

## Maintenance

Revisit this patch when Effect exposes equivalent ping/pong hooks without the dependency patch, changes
the RPC pinger or socket retry behavior, or provides a configurable liveness test seam.
