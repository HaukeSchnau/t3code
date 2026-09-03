# Codex Child Transcript Isolation

T3 Code carries a narrow fork patch for Codex app-server child transcripts. Upstream's native
task activities and Agents surface are authoritative for subagent identity, lifecycle, workflow
grouping, status, and usage.

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
- The web client omits `subagent.thread` transcript projections from the parent timeline. It does not
  parse them into a second roster or status model.
- Upstream's native `task.*` activities feed the shared subagent runtime fold and Agents panel for both
  Codex and other providers.

## Maintenance Notes

Remove the remaining fork patch when upstream guarantees that child assistant text cannot leak into the
parent transcript and provides any child transcript durability still required by provider recovery. Do
not reintroduce a Codex-only web parser or status projection alongside the native Agents model.
