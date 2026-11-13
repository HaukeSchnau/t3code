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
- **`t3 settings apply`** makes the stored document equal a desired one.
  - **Without `--base`**, it changes every document path that differs.
  - **With `--base`**, it changes only the paths where the desired document differs from the base,
    leaf by leaf, so a UI edit beside them survives until infra's reconciler captures it:
    - Arrays, atomic settings such as model selections, and secret references count as one leaf.
    - A provider's environment variables are matched by name.
    - An entry the desired document drops from a map is dropped whole.
    - A change inside an entry the UI deleted brings back the whole desired entry.

    **Secrets.** A secret the host holds that neither document holds was set in the UI. The
    reconciler can only ever capture its `valueRedacted` marker, so apply keeps it: a replaced value
    such as a device host list gets the marker back. If the slot is gone from the result, apply
    refuses. Only a secret the base held can be removed.

  - **Patch.** Either way it turns the target into a patch under the settings write lock:
    - Most keys are set whole.
    - `providerInstances` is replaced whole.
    - Other map entries, such as `projectSettingsOverrides`, are set or removed one by one.
    - `sourceControlHosts` entries cannot be removed, because their patch merges each host's
      fields; apply refuses.
  - **Like the UI.** As in the UI, it leaves out SSH device hosts that are this machine.
  - **Refusals.** It refuses a `valueRedacted` marker for a secret this host does not hold.
  - **Check.** It checks that the patched result equals the target before anything is written. A
    patch merges some values, for example `sourceControlHosts` fields or the background activity
    base profile, so a target the merge cannot reach fails, naming each path, instead of being
    stored half.
  - **`--dry-run`** runs everything except the write.
- **Report.** Both write commands print the document paths that changed, and every secret written
  or removed. When nothing changes, the server writes nothing and notifies no client
  (`StoredServerSettings.update`). That applies to every settings save, including the UI's. A write
  that timed out on the client but finished on the server is retried under `--wait` and then
  reports no change.
- **Live and offline.** Like `t3 project`, the command uses the running server when
  `server-runtime.json` names one that answers. It calls the fork routes `GET /api/server/settings`
  and `POST /api/server/settings` and `/api/server/settings/apply` (`status/http.ts`), with a
  two-minute local session that it revokes afterwards. The patch route requires the RPC's scopes,
  and apply requires `settings:write` and `providers:manage`. When no server answers, the command
  takes the server ownership lock and runs the same code against the state directory. With
  `--live-only` it exits 75 instead. It still attaches to the database to issue its session when a
  stale `server-runtime.json` names a server that is gone, but never takes the lock or migrates.
- **Offline `get` is not read-only.** It holds the ownership lock while it reads and may migrate
  the database, as the server does at start. A server that starts during those moments exits
  because the directory is owned. Callers that only read, such as the reconciler, pass
  `--live-only` or call the route.
- **Exit codes.** Failures print one message to stderr and leave stdout empty. A failure that may
  pass exits 75:
  - a held lock (a server starting or not answering)
  - a timeout
  - HTTP 404, 502, 503 or 504, or an unreadable answer (a server older than the CLI)
  - `--live-only` with no server answering

  Any other failure exits 1. `--wait <duration>` retries the temporary ones.

- **Callers.**
  - **Deploy hook.** Infra's deploy hook is a post-switch oneshot that runs `apply --wait`, because
    T3 does not restart on settings-only deploys. The deploy that first ships this command still
    runs the old server, which answers 404, so the hook also has to run when T3 starts.
  - **`--base`.** It is the last document that applied successfully. The first run on a host uses
    `--base {}`. Without `--base`, the document is the whole truth and removes every UI setting and
    secret it does not hold.
  - **Blocked deploys.** A repository change to a slot that holds a UI secret is refused until the
    reconciler has captured that secret, which blocks that host's deploys. Examples are a secret
    reference over it, the variable made non-sensitive, or the instance's driver changed.
  - **Captured markers.** Apply refuses a `valueRedacted` marker for a secret the host does not
    hold. So the reconciler puts captured values that carry a secret marker in the host's file,
    never in the fleet file.

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
