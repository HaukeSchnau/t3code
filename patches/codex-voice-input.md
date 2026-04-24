# Codex Voice Input

## Goal

Add minimal composer voice dictation to this fork using the user's existing local Codex auth.

## Reference

- Reference repo: `anthnykr/codex-voice`
- Reference commit: `ee4570c4ea71c13915d15954dc6c0798b60f76da`
- Relevant behavior: record audio locally, POST multipart `file` to `https://chatgpt.com/backend-api/transcribe`, authenticate with `~/.codex/auth.json` `tokens.access_token`, include `ChatGPT-Account-Id`, and refresh auth through `codex app-server account/read` with `refreshToken: true` after a `401`.

## Requirements

- Add a mic control to the chat composer footer.
- Add `Ctrl+M` as the default `voice.toggle` keybinding guarded by `!terminalFocus`.
- Use browser `MediaRecorder` for local audio capture.
- Send recorded audio only to the authenticated primary T3 server.
- Keep Codex access tokens server-side only.
- Proxy transcription through the server with the local Codex auth file from configured Codex home, falling back to `~/.codex/auth.json`.
- Use a pure TypeScript server transport. The ChatGPT endpoint rejects Node/Bun `fetch` with a Cloudflare 403 in local testing, so the server posts the multipart request through Node's built-in HTTP/2 client instead of using Swift or another native helper.
- Insert the transcript into the current composer draft for review.
- Never auto-send a transcribed prompt.
- Keep errors short and user-safe; never log or surface raw tokens, account ids, audio bytes, or transcript text.

## Non-Goals

- No realtime voice chat.
- No auto-send behavior.
- No selected remote environment routing.
- No provider-generic speech API.
- No global dictation app behavior.
- No large composer redesign.

## Risk

This uses a reverse-engineered Codex/ChatGPT transcription endpoint. It may break if Codex changes its internal transcription flow.
