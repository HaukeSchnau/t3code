# Codex Subagent Support

T3 Code carries a fork patch for Codex app-server subagents.

## Why

Codex Desktop and the Codex app-server can spawn child agent threads. Without explicit handling, child
thread notifications are projected into the parent T3 Code conversation as ordinary assistant text and
tool activity, which makes the main transcript noisy and misleading.

## Behavior

- Codex child notifications keep the parent T3 thread id but carry an `agentContext` with the child
  provider thread id and parent turn id.
- Runtime ingestion treats events with `agentContext` as subagent events. It upserts one
  `subagent.thread` activity per child provider thread and does not project child assistant text into
  parent assistant messages.
- Collab agent tool-call items remain in the parent work log and are enriched client-side into clickable
  subagent rows.
- The web UI opens a right-panel subagent inspector showing prompt, status metadata, and the latest child
  transcript projection.

## Maintenance Notes

Revisit this patch when upstream exposes first-class subagent thread projections or a stable app-server API
for reading child transcripts directly. Until then, keep the payload parser small and tolerate missing
optional fields from app-server notification variants.
