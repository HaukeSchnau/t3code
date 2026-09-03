# Durable agent watches

## Purpose

Adds server-owned, restart-durable command and WebSocket watches to the thread-orchestration CLI.
An agent can finish its turn while T3 Code keeps observing, then receive a typed queued notification
that starts a later turn. It also adds optional post-settlement summaries for existing durable
waits.

## Requirements

- `t3 thread watch create` accepts one shell command, argv array, or WebSocket source without a
  separate approval capability. This is an intentional maintainer choice for the personal fork.
- Open definitions survive server restarts. Restarting a source increments its generation, and
  every persisted event and delivered notification includes generation and sequence identity.
- Command stdout lines and WebSocket text frames are batched for 200 ms, capped to 500 characters
  per event and 3,000 characters per batch, and protected by a bounded flood gate.
- WebSockets reconnect after transient failures. Process exit and deadlines complete a watch;
  sustained overload and non-retryable source failures fail it.
- Notifications always enter the coordinator's durable FIFO queue. They never steer active work.
  Stopping a turn leaves watches open; cancellation, archive, and deletion stop them.
- An optional model policy uses the configured text-generation selection, normally GPT-5.6 Luna,
  to return `ignore`, `wake`, or `close` plus a summary. Generation failure wakes with raw events.
- Wait summaries use the same configured model only after deterministic settlement. Generation
  failure preserves the existing raw notification.
- Watch and wait deliveries retain a typed origin through events, projections, SQLite, snapshots,
  web, and mobile. They do not masquerade as editable user-authored chat messages.
- Open watches remain inspectable in the Work panel and through CLI read/list/cancel commands.

## Maintenance notes

The durable definition and event cursor live in thread coordination activities. Runtime source
ownership lives in `WatchRuntime.ts` and the thread-orchestration service. Message origin is stored
in the thread-message and queued-message projections; keep both paths aligned when changing message
persistence.

When upstream gains an equivalent watch primitive, prefer it if it preserves restart recovery,
typed origins, FIFO delivery, raw fallback, and all three client surfaces. Claude Code's Monitor
pacing and source semantics are the behavioral reference, but T3 Code owns durability because the
provider process may already have exited.
