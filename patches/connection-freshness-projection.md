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
  `unknown` while the connection is desired: at startup, during automatic recovery, after a live
  session is replaced, and on an explicit retry. Connection attempts and their backoff decide
  reachability. Upstream now probes a live session when the network reports offline and keeps it
  if it answers (`monitorConnectedLease`), but it still parks a desired connection in `offline`
  once that session is gone; the normalization reconnects instead.
- Web `ChatView.tsx` mounts `EnvironmentNetworkStatus` above the composer. That component in
  `components/chat/TrainNetworkStatus.tsx` subscribes to the environment's connection and shell
  itself, so shell pushes re-render the strip and not the chat, and renders the projection through
  `TrainNetworkStatus` and `trainNetworkExperience.ts`. It runs its own Reconnect through
  `environmentCatalog.retryNow`. Mobile does not use the projection.
- Since upstream's cold connects skip older settled threads, `live` means a partial shell. The
  projection only reports freshness, so it is unaffected.

## Upstream touch points

- `packages/client-runtime/src/connection/supervisor.ts`: the offline normalization.
- `apps/web/src/components/ChatView.tsx`: the `EnvironmentNetworkStatus` mount.
- `packages/client-runtime/package.json`: the `./state/connection-freshness` export.

## Removal

Retire this patch when upstream shows connection progress and content freshness in the chat view
and stops trusting a stale offline signal.

## Verification

`connectionFreshness.test.ts`, the stale-offline tests in `supervisor.test.ts`,
`TrainNetworkStatus.browser.test.tsx` and `trainNetworkExperience.test.ts`.
