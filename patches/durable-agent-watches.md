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
- WebSockets reconnect after transient failures. Successful process exit and deadlines complete a watch;
  sustained overload and non-retryable source failures fail it.
- Server shutdown interrupts scoped watch workers without closing their durable definitions.
  SIGTERM/SIGINT handling also suppresses terminal transitions from children killed by systemd
  before scope cleanup. Startup resumes the open definitions. Nonzero command exits report their
  exit code; signal failures report the underlying OS error rather than the command text.
- Notifications always enter the coordinator's durable FIFO queue. They never steer active work.
  Stopping a turn leaves watches open; cancellation, archive, and deletion stop them.
- An optional model policy uses the configured text-generation selection, normally GPT-5.6 Luna,
  to return `ignore`, `wake`, or `close` plus a summary. Generation failure wakes with raw events.
- Wait summaries use the same configured model only after deterministic settlement. Generation
  failure preserves the existing raw notification.
- Watch and wait deliveries retain a typed origin through events, projections, SQLite, snapshots,
  web, and mobile. They do not masquerade as editable user-authored chat messages.
- Open watches remain inspectable in the Work panel and through CLI read/list/cancel commands.
- Web, desktop, and mobile show one stable lifecycle row per watch. Event decisions remain
  durable diagnostics and do not render in chat, including historical ignored events.
- Model policies skip identical consecutive batches within a source generation before invoking
  text generation. Always-notify watches preserve every event; a restarted source evaluates its
  first report again. Prefer event-driven sources or emit only changed snapshots for monitoring.

## Maintenance notes

The durable definition and event cursor live in thread coordination activities. Runtime source
ownership lives in `WatchRuntime.ts` and the thread-orchestration service. Message origin is stored
in the thread-message and queued-message projections; keep both paths aligned when changing message
persistence.

When upstream gains an equivalent watch primitive, prefer it if it preserves restart recovery,
typed origins, FIFO delivery, raw fallback, and all three client surfaces. Claude Code's Monitor
pacing and source semantics are the behavioral reference, but T3 Code owns durability because the
provider process may already have exited.
