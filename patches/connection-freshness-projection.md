# Shared connection freshness projection

## Requirement

The chat view must say when an environment is reconnecting, waiting to retry, or blocked, and
whether the visible content is saved or live. Upstream's `EnvironmentConnectionPresentation` only
gives a coarse connection state. A stale browser offline signal must not stop reconnection to a
reachable server.

## Implementation

- `packages/client-runtime/src/state/connectionFreshness.ts`, exported as
  `@t3tools/client-runtime/state/connection-freshness`, projects `SupervisorConnectionState` and
  the environment shell state into one typed value. It carries the setup stage, attempt, failure
  and absolute `retryAt`, plus the shell's freshness (`empty`, `cached`, `synchronizing`, `live`)
  and the content snapshot's sequence.
- The projection only observes. It never calls `connect`, `retryNow` or a transport API, and
  `retryRemainingMs` compares `retryAt` with a clock value the caller passes in.
- Supervisor and shell state update independently. When the connection is not `connected` but the
  shell still reports `live`, the projection downgrades freshness to `cached`. It never claims
  live data without a transport.
- The source types use nullable fields, so they can describe combinations their state machines
  never publish. The projection throws on those instead of emitting an invalid value, such as a
  backoff without a failure or a live shell without a snapshot.
- `connection/supervisor.ts` (`normalizeDesiredIntent`) treats a browser `offline` report as
  `unknown` while the connection is desired: at startup, during automatic recovery, and on an
  explicit retry. Connection attempts and their backoff decide reachability.
- Web `ChatView.tsx` builds `activeConnectionFreshness` and renders it above the composer through
  `components/chat/TrainNetworkStatus.tsx` and `trainNetworkExperience.ts`. Mobile does not use
  the projection.

## Upstream touch points

- `packages/client-runtime/src/connection/supervisor.ts`: the offline normalization.
- `apps/web/src/components/ChatView.tsx`: the projection and the `TrainNetworkStatus` mount.
- `packages/client-runtime/package.json`: the `./state/connection-freshness` export.

## Removal

Retire this patch when upstream shows connection progress and content freshness in the chat view
and stops trusting a stale offline signal.

## Verification

`connectionFreshness.test.ts`, the stale-offline tests in `supervisor.test.ts`,
`TrainNetworkStatus.test.tsx` and `trainNetworkExperience.test.ts`.
