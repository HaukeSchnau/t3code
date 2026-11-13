# Settings CLI

## Requirement

The infra repository declares server settings in Nix, per fleet and per host. A deploy applies
them to every host, and a reconciler on srv-1 reads each host's settings to capture what was changed
in the UI. Both need a scriptable way to read the stored settings and change them along the path
the settings UI takes:

- T3 validates the change, so a bad declaration fails instead of breaking the server.
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

- **Document.** A settings document is the form `settings.json` would have if it held only patchable
  keys (`settingsAccess.ts`). It leaves out keys a patch cannot set (`defaultTheme`,
  `projectSettingsFolded`, `previousWorktreesDirectories`, `usageModelFilter`) and keys every save
  derives from another one (`compactIdleThreads`, the legacy project override maps and background
  activity fields). It is stripped against the same defaults the server writes against, normalized
  the way a load normalizes them. Secrets are redacted as the UI sees them, with references kept.
- **`t3 settings get`** prints the effective settings, or the document with `--sparse`. Both fail
  when `settings.json` does not decode, rather than print the defaults the server falls back to.
- **`t3 settings patch`** decodes a `ServerSettingsPatch` and rejects unknown keys. It applies the
  patch through `applyServerSettingsPatch`, the UI's path.
- **`t3 settings apply`** makes the stored document equal a desired one. Without `--base`, it
  changes every document path that differs. With `--base`, it changes only the paths where the
  desired document differs from the base, so a UI edit elsewhere survives until infra's reconciler
  captures it. Either way it turns the difference into a patch under the settings write lock:
  - Most keys are set whole.
  - Map entries such as `projectSettingsOverrides` are set or removed one by one.
  - `providerInstances` is replaced whole.

  It then checks that the patched result equals the target before anything is written. A patch
  merges some values, for example `sourceControlHosts` fields or the background activity base
  profile, so a target the merge cannot reach fails instead of being stored half. `--dry-run`
  runs everything except the write.

- **Report.** Both write commands print the document paths that changed, and every secret written
  or removed. When nothing changes, the server writes nothing and notifies no client
  (`StoredServerSettings.update`). That applies to every settings save, including the UI's.
- **Live and offline.** Like `t3 project`, the command uses the running server when
  `server-runtime.json` names one that answers. It calls the fork routes `GET /api/server/settings`
  and `POST /api/server/settings` and `/api/server/settings/apply` (`status/http.ts`), with a
  two-minute local session that it revokes afterwards. The patch route requires the RPC's scopes,
  and apply requires `settings:write` and `providers:manage`. When no server answers, the command
  takes the server ownership lock and runs the same code against the state directory.
- **Offline `get` is not read-only.** It holds the ownership lock while it reads and may migrate
  the database, as the server does at start. A server that starts during those moments exits
  because the directory is owned. Callers that only read, such as the reconciler, use the live
  route.
- **Exit codes.** Failures print one message to stderr and leave stdout empty. A failure that may
  pass exits 75. That covers a held lock (a server starting or not answering), a timeout, and HTTP
  404, 502, 503 or 504 or an unreadable answer (a server older than the CLI). Any other failure
  exits 1. `--wait <duration>` retries the temporary ones. Infra's deploy hook is a post-switch
  oneshot that runs `apply --wait`, because T3 does not restart on settings-only deploys.

## Upstream touch points

- `apps/server/src/serverSettings.ts`:
  - The upstream update path becomes `updateWithReport`, which `updateSettings` and
    `updateProviderInstance` call.
  - `updateWithReport` takes a `check` and a `dryRun`, drops secret operations that leave a secret
    as it is, and skips a write that would store the same file.
  - `renderSettingsFile` is split out of `writeSettingsAtomically`.
  - `layer` also provides the fork's `StoredServerSettings`.
  - `stripDefaultServerSettings` and `ATOMIC_SETTINGS_KEYS` are exported.
- `apps/server/src/ws.ts`: the `server.updateSettings` handler calls `updateSettingsForClient`, so
  the RPC and `t3 settings patch` share the `deviceHosts` filtering.
- `apps/server/src/binCli.ts` registers the command.
- `packages/contracts/src/environmentHttp.ts` adds the routes to the fork's `server` group, typed in
  `packages/contracts/src/settingsCli.ts`.

## Removal

Drop this patch if upstream adds a settings command, or an HTTP API that applies a patch through
the settings service with the same report. Infra's settings layers and reconciler would move to it.
