# Codex Thread Resume Deeplink

## Intent

T3 Code supports an explicit desktop deeplink for resuming an existing Codex thread:

```text
t3code://codex/resume?threadId=<codex-thread-id>
```

The deeplink is intentionally user-triggered. It replaces the removed automatic Codex thread import/sync behavior and must not list, poll, or background-sync Codex threads.

## Behavior

- The desktop shell parses `t3:`, `t3code:`, and `t3code-dev:` URLs for the `codex/resume` route.
- The URL carries only `threadId`; it does not accept a `cwd` parameter.
- The server uses Codex `thread/read` for that thread id and trusts Codex's thread metadata for the bound `cwd`.
- T3 Code creates or reuses the project for that `cwd`, creates or reuses a T3 thread with the Codex thread id, imports historical user and assistant messages, and records the Codex resume cursor.
- The provider session is left in `stopped` state so the user can resume on demand from T3 Code.

## Maintenance Notes

- Keep this path narrow and explicit. Do not reintroduce automatic thread discovery or background sync through this patch.
- If Codex `thread/read` changes its turn item schema, update the transcript mapper in the server RPC handler.
- If provider instances become a first-class Codex UX, revisit the provider instance selection. The current patch uses the default enabled Codex provider instance, falling back to the first enabled Codex instance.
