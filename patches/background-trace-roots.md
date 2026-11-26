# Background trace roots

## Requirement

Each cycle of a server background loop must start its own trace. Upstream forks the loops in
`forkParked` (`apps/server/src/serverActivation.ts`) under the span that started them, which
belongs to the server's lifetime trace. Every sweep, poll and event batch of every loop then
joined one trace that only ends when the server stops. Tempo drops spans past a trace's size
limit: on 2026-11-22 it dropped about 19 of the 22 spans/s the fleet sent as `trace_too_large`,
and its search listed those traces as "root span not yet received". Upstream already starts a
separate trace for each HTTP request
(`withRootRequestSpans` in `apps/server/src/http.ts`) for the same reason.

## Implementation

`forkParkedFiber` removes `Tracer.ParentSpan` from the forked effect's context, so the first span
of each cycle is a root.

## Removal

Retire this patch when upstream starts background loops without the parent span.

## Verification

`apps/server/src/serverActivation.test.ts`.
