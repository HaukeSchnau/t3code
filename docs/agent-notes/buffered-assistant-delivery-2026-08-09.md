# Buffered assistant delivery — 2026-08-09

## Goal

Make the fresh-install `enableLegacyTokenStreaming: false` default effective for real providers while
preserving every accepted assistant byte across server process loss.

## Evidence and decision

- The production setting was live and decoded to `false`, but all built-in adapters declared
  `assistantTranscriptRecovery: "none"`.
- Ingestion therefore forced token streaming before it consulted the setting.
- Every built-in adapter already passes semantic transcript events through the shared durable acceptance
  gate. Deltas and lifecycle boundaries are committed to `provider_transcript_journal` before volatile
  delivery, and rows remain until the corresponding projection command is durable.
- Journal membership, rather than an adapter history claim, is the truthful recovery guarantee for this
  delivery decision. Unjournaled events retain the existing requirement for an authoritative adapter.

## Implementation and verification

- Thread journal provenance through runtime processing and treat journal-backed parent and subagent
  transcript events as authoritatively recoverable.
- Keep the 24,000-character memory safety spill; ordinary replies arrive at completion or interaction
  boundaries, while very large replies may publish bounded chunks.
- Extend the hard-kill integration fixture to prove a journal-backed delta from an adapter with no history
  recovery remains invisible before a boundary and still recovers after `SIGKILL`.
- Focused ingestion and journal tests pass locally. The hard-kill regression first failed against the old
  capability gate, then passed with three accepted events recovered after `SIGKILL`.
- Scoped formatting, lint, and the server package typecheck pass.

## Remaining work

- Commit and push `main`.
- Deploy the server package, then verify the live package identity and setting behavior.
