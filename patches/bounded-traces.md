# Bounded traces

## Requirement

No trace may grow for longer than a few minutes. Tempo keeps a trace in memory while its spans
keep arriving and drops spans past a trace's size limit. Upstream runs the whole server under one
lifetime span (`server.runServerCommand`), and long-running work keeps its parent: background
loops forked while a service is built, `Scheduler` sources (`register` re-provides the context it
captured, span included, to every run), delegation followers forked by the request that started
them, and WebSocket subscriptions that stay open per client. Each of them added to one trace for
as long as it ran. On 2026-11-22 Tempo dropped about 19 of the fleet's 22 spans/s as
`trace_too_large`, and on 2026-11-26 it stalled at its memory limit, with 69% of srv-2's spans in
traces of over 200 spans. Upstream starts a separate trace only for HTTP requests
(`withRootRequestSpans` in `apps/server/src/http.ts`).

## Implementation

- `boundTraces` (`apps/server/src/observability/BoundedTraces.ts`) wraps the server's tracer: a
  span whose parent has ended, or whose trace started in this process more than ten minutes ago,
  starts a new trace with a link to that parent. Trace age comes from a monotonic clock, since
  span start times read 0 with trace timing off. A parent from another process keeps its trace.
  A turn longer than ten minutes shows as several linked traces.
- `runServer` (`apps/server/src/server.ts`) builds the server's layers with
  `withRootRequestSpans`, so services never start under the lifetime span.

## Removal

Retire this patch when upstream bounds its traces: no long-running work under the lifetime span,
and loops, followers and subscriptions that start a trace per cycle.

## Verification

`apps/server/src/observability/BoundedTraces.test.ts`.
