# Codex structured user input

## Requirement

Codex must be able to ask structured questions in Default mode, not only in Plan mode, on web,
desktop, iOS and Android. A question that Codex marks as non-blocking must be skippable, so Codex
can continue with its best judgment. Upstream leaves Codex's `default_mode_request_user_input`
feature off.

## Implementation

- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` starts every `codex app-server` process with
  `-c features.default_mode_request_user_input=true` (`CODEX_STRUCTURED_USER_INPUT_ARGS`). A
  process-level flag reaches new and resumed threads. Per-thread config would change the recorded
  `thread/start` frames that upstream's replay fixtures match exactly.
- No instruction text. T3 uses Codex's native collaboration modes, and Codex's own Default-mode
  template (`codex-rs/collaboration-mode-templates/templates/default.md`) already tells it to use
  `request_user_input` when listed, to use it for optional questions, and to continue when it
  returns no answers.
- The adapter turns a request with `isBlocking: false` into questions with `required: false` on
  upstream's question contract. A request without the field stays blocking, as Codex treats it.
- When every question is optional, the prompt shows an Optional label and a Skip action that
  answers `{}`. Web and desktop use `isOptionalPendingUserInput` in `pendingUserInput.ts`,
  `ComposerPendingUserInputPanel.tsx`, and the Skip handler in `chat/usePendingThreadRequests.ts`. Mobile has its own copy in `lib/threadActivity.ts` and
  renders it in `PendingUserInputCard.tsx`.

## Removal

Drop the launch flag when upstream enables Default-mode questions. Drop
the Skip controls when upstream renders optional questions itself.

## Verification

`CodexAdapterV2.test.ts` covers the launch arguments and a non-blocking request.
`pendingUserInput.test.ts` and mobile `threadActivity.test.ts` cover optional detection. After a
Codex or composer sync, exercise a live Default-mode question on desktop and on a narrow viewport.
