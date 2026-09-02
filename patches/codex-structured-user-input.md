# Codex Structured User Input

## Requirement

Codex must be able to ask structured questions through T3 Code on web, desktop, iOS, and Android.
The prompt must remain usable over remote and multi-device connections, and abandoned provider
requests must not leave a stale question blocking the composer.

## Design

- Enable Codex App Server's `default_mode_request_user_input` feature for both new and resumed
  threads.
- Keep the existing provider-neutral user-input contract and orchestration flow. Codex translates
  `item/tool/requestUserInput` at the adapter boundary instead of adding a Codex-only client API.
- Preserve the App Server JSON-RPC request id and raw request metadata beside the generated typed
  payload. This carries the newer `isBlocking` field without hand-editing generated protocol files.
- Treat `isBlocking: false` as optional user input. Web, desktop, iOS, and Android label these
  prompts and offer **Skip**, which answers with an empty result so Codex can use its best judgment.
  Missing metadata remains blocking for compatibility with older Codex versions.
- Keep the web and desktop prompt inside the composer's `ComposerBanner` attachment stack. The
  question card uses that root's grid and spacing variables, so rendering it directly inside the
  main input surface breaks its header, body alignment, and neighboring stash tab.
- Correlate `serverRequest/resolved` with the pending prompt. Provider resolution, a new or completed
  turn, interruption, process exit, and runtime close all settle and remove pending input.
- Return an empty answer immediately when Codex sends no renderable question, preventing an
  invisible pending request.

## Upstream Dependency

This patch depends on Codex App Server's `item/tool/requestUserInput` server request,
`serverRequest/resolved` notification, and `features.default_mode_request_user_input` config flag.
When updating Codex protocol bindings, keep the raw request context until generated schemas expose
`isBlocking` directly, then remove the compatibility decoder.

## Verification

- The Effect Codex client test covers typed request handling plus raw id and metadata preservation.
- Codex runtime tests cover feature configuration and out-of-band request settlement.
- Adapter and ingestion tests cover optional metadata normalization and persistence.
- Web and mobile state tests cover optional prompt derivation; package typechecks cover the shared
  Skip controls on every client surface.
- Exercise a live Codex prompt at desktop and narrow viewport widths after composer or banner syncs.
