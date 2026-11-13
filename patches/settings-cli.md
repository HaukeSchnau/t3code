# Settings CLI

## Requirement

The infra repository declares server settings in Nix, per fleet and per host, and its reconciler
reads every host's settings to capture what was changed in the UI. Both need a scriptable way to
read the effective settings and to apply a patch, and the patch must take the path the settings UI
takes:

- T3 validates it, so a bad declaration fails instead of breaking the server.
- T3 strips defaults when it saves, so a reset to a default is recorded.
- T3 moves sensitive values, such as sensitive provider environment variables, into its secret
  store.

Writing `settings.json` directly does none of that. A file the server cannot decode makes it fall
back to all defaults and refuse later saves (`serverSettings.ts`), and the sparse file cannot tell
a value reset to its default from one that was never set.

## Why upstream doesn't meet it

Upstream changes settings only through the `server.updateSettings` WebSocket RPC, which needs a
paired client. It has no settings command and no HTTP route for settings.

## Implementation

- `t3 settings get [--json] [--sparse]` prints the effective settings, defaults included, redacted
  the way the server redacts them for clients that understand secret references
  (`settingsAccess.ts`). `--sparse` leaves out values equal to T3's built-in defaults, which matches
  what the server writes to `settings.json`.
- `t3 settings patch [--json] <file|->` decodes a `ServerSettingsPatch` and rejects unknown keys,
  which the schema would otherwise drop. It applies the patch through
  `ServerSettingsService.updateSettings`, then prints the leaf values that changed.
- Like `t3 project`, the command uses the running server when `server-runtime.json` names one that
  answers. It calls the fork's `GET` and `POST /api/server/settings` (`status/http.ts`) with a
  short-lived local session. The `POST` route requires the scopes of the RPC
  (`requiredScopesForServerSettingsPatch`). When no server answers, the command takes the server
  ownership lock and runs the same settings service against the state directory. The lock makes it
  fail rather than write behind a server that is running but unreachable. A server that answered
  and then failed or rejected the patch is never retried offline.
- `updateSettingsForClient` repeats the `deviceHosts` filtering of the `server.updateSettings`
  handler in upstream's `ws.ts`. After an upstream sync, compare the two and carry over any new
  step.
- Failures print one message to stderr and exit 1, leaving stdout empty for scripts.

## Upstream touch points

- `apps/server/src/binCli.ts` registers the command.
- `apps/server/src/serverSettings.ts` exports `stripDefaultServerSettings` for `--sparse`.
- `packages/contracts/src/environmentHttp.ts` adds the routes to the fork's `server` group.

## Removal

Drop this patch if upstream adds a settings command, or an HTTP API that applies a patch through
`ServerSettingsService.updateSettings`. Infra's settings layers and reconciler would move to it.
