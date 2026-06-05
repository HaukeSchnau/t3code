# Codex Stored Thread Sync

## Goal

Import locally stored Codex app threads into T3 Code so prior Codex conversations are visible in
the project/thread UI without forcing a full message hydration pass during server startup.

## Source Context

- Backfilled from the current fork delta against `main@upstream`.
- Local commit trail: `feat: import codex app threads`, `feat: sync codex app thread updates`,
  `fix: unblock codex thread sync startup`, `fix: hydrate codex thread messages on open`,
  `fix: show thread sync indicator`, `fix: preserve Codex stored thread message order`,
  `fix: avoid SQLite lock during Codex sync`, and `fix: lazy-load Codex stored thread messages`.
- Session archive search for Codex sync mostly surfaced implementation/test evidence rather than
  a prose requirements doc, so this file records the inferred requirements from the committed code
  and tests.

## Requirements

- Sync only enabled Codex provider instances.
- Start server-side Codex stored thread sync from provider/runtime startup, but keep failures
  best-effort and logged; sync failures must not prevent the server or active provider sessions
  from starting.
- Prefer `listStoredThreadShells` at startup. Startup sync should import/update thread shells
  without reading every stored turn from Codex.
- Fall back to `listStoredThreads` only when shell listing is unavailable, and still discard
  message payloads for startup imports so message hydration remains lazy.
- Create a project for a stored Codex thread when no active project exists for the stored thread's
  `cwd`; otherwise attach the thread to the existing project for that workspace root.
- Use the Codex provider thread id as the imported T3 thread id when no existing provider binding
  is present.
- Persist a provider session binding with `resumeCursor.threadId` pointing at the Codex stored
  thread id so future opens can resume/hydrate the correct Codex thread.
- Hydrate messages on explicit thread open through `syncCodexStoredThreadByThreadId`.
- Batch message sync commands in small chunks. The current batch size is 25 stored messages.
- Avoid duplicating messages by checking both stable message ids and normalized role/text content
  ordinals.
- Preserve stored message order and timestamps as emitted by Codex.
- Keep imported stored threads stopped until a user opens/resumes them.
- Surface thread sync activity through existing session/runtime metadata rather than adding a new
  WebSocket API.

## Upstream Touch Points

- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/codexStoredThreadSync.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/orchestration/decider.ts`
- `packages/contracts/src/orchestration.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/MessagesTimeline.tsx`

## Non-Goals

- Do not import ephemeral Codex threads.
- Do not continuously mirror every stored Codex message at startup.
- Do not mutate Codex's on-disk storage.
- Do not add a new provider-agnostic import dashboard until upstream has a compatible model.

## Verification

- `apps/server/src/provider/codexStoredThreadSync.test.ts`
- `apps/server/src/orchestration/decider.import.test.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`
- `apps/web/src/components/ChatView.browser.tsx`
- Required repo gates: `vp check` and `vp run typecheck`.
