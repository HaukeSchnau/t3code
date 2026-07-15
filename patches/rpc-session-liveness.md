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
the public transport boundary. The dependency-wire test decodes outbound frames by tag rather than
depending on a request's frame index or the socket's total message count. It observes an encoded Effect
RPC `Ping`, replies with `Pong`, then observes and withholds the next pong.

Liveness measurement starts when the fake transport observes that second outbound `Ping` and ends when
`RpcSession.closed` resolves with a transient transport error and the WebSocket has closed. Effect's
current pinger checks for an unanswered ping on its next five-second cadence, so the maximum expected
timeout envelope is five seconds from the observed unanswered ping to closure. The test advances fake
time in one-second increments within that envelope. After closure it keeps the scoped session alive for
six more seconds—longer than another complete dependency cadence—before asserting that the session's
configured zero-retry policy constructed only one socket.

That five-second cadence is dependency-owned, not a client-runtime policy; the test intentionally avoids
duplicating it in production code. On Effect upgrades, review `patches/effect@4.0.0-beta.78.patch` and
this transport-boundary test together.

A focused composition test provides the real `RpcSessionFactory` through the real connection driver and
`EnvironmentSupervisor`. It withholds a ping response, observes the supervisor's backoff while the
session still owns exactly one socket, then advances the supervisor's one-second retry delay and verifies
exactly one supervised replacement. This is application reconnect-ownership evidence, separate from the
dependency-wire cadence evidence above. Existing supervisor tests continue to verify general involuntary
closure behavior and that stalled connection setup and foreground probes retain their 15-second
boundaries.

## Maintenance

Revisit this patch when Effect exposes equivalent ping/pong hooks without the dependency patch, changes
the RPC pinger or socket retry behavior, or provides a configurable liveness test seam.
