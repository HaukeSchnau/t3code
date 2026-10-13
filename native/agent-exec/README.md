# agent-exec

Linux filesystem environments for T3 workspaces. T3's Linux Release ships it (`nix/agent-exec.nix`) and sets `T3CODE_EXECUTION_LAUNCHER` to it, so T3 always calls the agent-exec it was released with. Its mounts, file publishing and account adapters are policy for Hauke's NixOS hosts. Those hosts provide FUSE, the `agent-workspace-files@` user unit and an `agent-exec` command that runs the active Release's copy.

T3 invokes `fork SOURCE DEST --workspace-id ID --project-id ID --profile familiar|minimal` through its existing workspace service, and `auto --cwd CWD -- COMMAND...` for registered workspace processes. A workspace owns files and runtime state; several threads can use it. `create ROOT --project-id ID` remains available for legacy separate projects. `exec` requires a registration; `inspect ROOT` reports it.

State lives below `~/.local/state/agent-exec`: `projects` contains version-1 registry records, and `environments` contains private homes, provider state, and per-project bridge sockets. Registration is outside the agent-visible filesystem and survives T3 restarts. T3 reads the records in `apps/server/src/project/SeparateProjectRegistry.ts`.

The runtime shares the Nix store, OS tools, ordinary network, Nix daemon, global instructions, skills/plugins, Git/SSH configuration, and native account tools through the host bridge. It does not mount other project directories, the infra checkout, host process state, the systemd user bus, or T3's database. T3 attachment storage remains read-only/shared to support attachments arriving after a provider starts. This is context isolation, not a security sandbox.

Codex uses private runtime state with its native auth file bind-mounted writable. Verified against `rust-v0.153.4`'s `FileAuthStorage::save`, which updates the file in place. Login/logout or storage-format changes need outside help and a runtime review. Claude's configuration directory supports native atomic credential replacement; existing non-configuration entries and known runtime directories are masked with project-private storage. Account tools keep their configuration, secrets, refresh tokens, and keyrings on the host. There is no separate list of mail/vault/forge secret mounts to maintain. Git and Jujutsu stay local to the project, with normal Git/SSH configuration and GitHub credential helpers routed through `gh`. An available SSH agent socket is forwarded. Connection multiplexing sockets configured under `~/.ssh` are disabled inside the environment, because that directory is read-only there.

Native account commands include `gog`, `himalaya`, `personal-email-health`, `bw-personal`, `bw-work`, `bitwarden-agent-health`, `slackcli`, `gh`, `tea`, and the store CLIs `asc` and `gplay`. They keep their CLI arguments, stdin/stdout/stderr, exit status, cancellation, and interactive terminal behavior. A Unix socket passes the standard file descriptors to the host worker. Interactive calls with all three descriptors attached to a terminal get a controlling PTY with window-size forwarding. Mixed terminal/redirection calls retain their separate descriptors but do not get a new controlling terminal.

`agent-device` uses the launching T3 environment's generated launcher under `userdata/device/bin`. Call `device_open` first and retain its `--config` and `--session` arguments. The host executes the command with access to T3's SSH forwards; project paths, `/tmp`, and published artifacts use the same file exchange mounts as account commands. `agent-exec` writes the capability wrapper to that path in the private home on every launch. Unlike mounts, this reaches provider processes started before a runtime update. `help`, `--help` and `-h` calls need no device flags; the host still validates `--config` for everything else. The bridge does not fall back to a global device CLI. It runs in the host network namespace, so `agent-device cdp` without `--url` probes host loopback. Device reservations and human takeover remain responsibilities of T3 and the device host.

File exchange uses canonical project paths, shared `/tmp`, project publishing at `/srv/agent-share`, and project-scoped Bitwarden attachment staging. Put uploads and downloaded files there. Arbitrary files in the private home are not automatically translated into the account tool's host home. Host account tools deliberately retain normal host access; this is not a security boundary. Native secret refresh remains the tool's responsibility.

A transient user-systemd bridge starts on demand, uses readiness notification, and is replaced when the launcher version changes. It provides:

- `agent-service`: project-scoped names, finite logs/status, list, publication, and service processes that re-enter the project environment. `--help` describes the supported project commands.
- `chat-export`: the host share-link exporter, with output files exchanged through the project and scratch mounts.
- Account CLIs: native host execution with project file-exchange mounts. A fresh `/dev` is necessary for native CLI startup in Bubblewrap. Its user namespace shows root-owned Nix store files as `nobody`'s, and OpenSSH refuses such configs, so SSH from an account CLI reads the environment's owned config copies, without multiplexing. Host values such as `HOME`, `PATH` and `SHELL` override the caller's; ssh runs `Match exec` through `$SHELL`, and the environment's `/bin/bash` does not exist on the host.
- `agent-browser`: a persistent browser profile and socket directory scoped to the project; `--session NAME` creates another context within that project. Screenshots and default downloads go into shared project scratch storage. Chromium's internal sockets use the shorter host `/tmp` path.
- `agent-browser-personal` and `agent-browser-buildlinx`: explicit access to the existing host account browsers, using their native managed profiles. These contexts are shared with outside work. Coordinate their use as usual; there is no cross-agent transaction lock covering a sequence of browser commands.
- `bitwarden-browser-ui-personal` and `bitwarden-browser-ui-work`: the Bitwarden extension popup controllers for those account browsers, needed for passkey ceremonies.
- `play-console-browser`: the persistent `srv-2` Google Play Console browser, signed in to the Urbs developer account, for console-only steps the Android Publisher API lacks. It is shared host state like the account browsers.

Agents reach T3 itself through its MCP tools, which work inside the environment. For outside infrastructure help, the generated instructions tell them to start a thread in the infra project and watch it, so its answer wakes them.

No browser is launched during package tests. Run `python3 -B -m unittest discover -s native/agent-exec -p 'test_*.py'` with `tomli-w` installed for focused launcher tests. The derivation also runs these tests.

Deleting a workspace in T3 runs `retire ROOT --remove-checkout`, which removes the checkout, the registration and the private state: home, provider state and tool caches. Published files stay. Removing a T3 project does not remove its files or private environment state. Stop its previews with `agent-service` and its threads through T3 before manually retiring the registration/state. Native session imports are not implemented.

## Project file publishing

Each registered project gets `/srv/agent-share/isolated/<project-identity>` on the host. Only that directory is mounted at `/srv/agent-share` inside its environment. `$AGENT_SHARE_URL` gives the corresponding `https://files.schnau.dev/isolated/<project-identity>` URL prefix, also included in the generated provider instructions. Existing shared files and other projects' publishing directories are absent from the filesystem view. The normal shared-directory ACL applies. Copying or moving an existing private file can preserve a mode that blocks the web server; run `chmod -R g+rX` on the published files/directories afterward. Ordinary network access remains available, including explicitly requested URLs; this does not make published artifacts confidential from other Tailnet clients.

## Entering from SSH

After connecting to srv-2, run `agent-exec exec --cwd /absolute/project/path -- bash`. The host command runs the active Release's copy, the one T3 providers and terminals use. Reopen an existing terminal or provider process after a runtime update to pick up mount and wrapper changes.

## Independent workspaces

`fork` creates a separate colocated jj repository at a selected revision. It removes the temporary source transport remote, inherits the source's configured fetch/push remotes, shares no mutable repository state, and appears inside as `~/<name>`. Remote URLs and refspecs are copied; hooks and unrelated repository configuration are not. Relative local remote paths are resolved against the source checkout. Both Git repositories and shared jj workspaces can be sources. The source is snapshotted once for the requested export; a temporary transport ref is removed afterward. The destination gets its own working-copy change. `collect` imports a selected snapshot behind an `incoming/*` bookmark without editing or rebasing the destination working copy. Git destinations receive an incoming branch with the same guarantee. Integration remains an explicit VCS operation. A matching workspace id and request reuse the existing checkout, including unfinished edits, after a lost acknowledgement.

```sh
agent-exec fork /host/source /host/new-workspace --name my-project --revision @ --profile minimal
agent-exec exec --cwd /host/new-workspace -- bash
agent-exec collect /host/new-workspace /host/integration --revision @
agent-exec inspect /host/new-workspace
agent-exec retire /host/new-workspace
```

The `minimal` profile omits global instructions and skills. `familiar` snapshots the current global instructions and exposes normal skills/plugins. Both pin the same small Nix baseline and keep native account commands available through the bridge. The host's system/profile bin directories are absent; provider binaries and jj convenience commands are selected explicitly. Provider configuration omits unrelated project registrations. Account capabilities and familiar-profile skills remain host-managed, not frozen copies of credentials. This is context isolation, not a security boundary.

Directory projects use the same private runtime. A userspace union filesystem reads ordinary files from the source and copies individual files into private storage when written. Untouched files can reflect later source changes; this is not a snapshot. The source must remain available. This works on XFS without filesystem snapshots or recursive file copying. Repository discovery walks to any depth, skips dependency/provider caches and directory symlinks, and stops at each Git/jj boundary. Each discovered repository gets an independent checkout, including sources whose metadata lives outside their working tree. Source-only ignored files inside those repositories are hidden. Cloning runs four repositories at a time, so projects with many repositories still have a provisioning cost. `collect` operates on a selected repository path inside the directory project.

The directory mount is owned by an `agent-workspace-files@` user service. It survives provider retirement and returns after login or reboot, keeping retained files available to editors and T3. Explicit `retire ROOT --remove-checkout` removes it and its private writes; deletion refuses a source still used by another directory workspace.

The launcher selects the nearest `devenv.nix` or `flake.nix` between the command
and workspace root. Devenv takes precedence when both occur together, so the
flake can still own releases. Nested projects choose their own definition.
Bash commands refresh the environment, including `/bin/bash` invoked by a
running provider. Existing processes retain their environment.

For devenv, commit `devenv.nix`, `devenv.yaml`, and `devenv.lock`. The runtime pins
CLI 2.3.1 and runs `tasks run devenv:enterShell --mode all` followed by
`print-dev-env --json`, then the hook and task exports. This explicit task command
fails setup reliably; 2.3.1's `devenv shell` convenience command ignores failed
entry tasks. Setup output is replayed on stderr only when a step fails, times out,
or is cancelled; successful entries print nothing except hook output and task
messages. A created or updated `devenv.lock` is announced on stderr.
Native devenv creates a missing lock and reconciles changed declared inputs during
entry. Review and commit the resulting lock; the adapter does not freeze it.
Use `agent-exec exec --cwd WORKSPACE --environment baseline -- bash` to repair a
broken definition or run an explicit `devenv update`. The override also accepts
`auto`, `devenv`, and `flake`.

Cold devenv setup reports its current phase on stderr every 15 seconds while it
runs or waits for another entry. Warm entries stay quiet. Each setup step and
lock wait has a 15-minute limit; timeout stops the setup processes and prints an
exact baseline repair command. A known slow first install can use a larger
budget, for example `agent-exec exec --cwd WORKSPACE --setup-timeout 1800 -- bash`.
This changes the setup budget, not the requested command's runtime. Repairing a
broken definition does not require successful setup. From an agent whose shell
is blocked, use its editor/file tool to create `.devenv/agent-exec-baseline` at
the selected environment root. Subsequent commands use baseline tools and print
a repair-mode notice. Fix the definition, then delete the marker to resume
normal setup. The marker lives in private, ignored devenv state.

Devenv evaluation/task state, generated files and sockets stay private in each
workspace. Plain-directory lower caches are masked at mount and at entry,
including a nested root first used by an existing shell. Concurrent automatic
entries serialize setup. Native tasks already own their environment and do not
recursively activate wrapped shells. Removed declared variables disappear on
nested entry. Store closures have host-visible GC roots. The adapter shares the
Nix store, but does not share exported devenv environments or task success.

Flake-only projects still provide `devShells.<system>.default`. Nix uses the Git
tracked-file view. In a jj repository, activation snapshots the working copy
when a non-ignored file is missing from the Git index; files jj declines to
track, such as oversized ones, do not repeat the snapshot. Successful evaluations share
a cache per project, tracked source, revision, visible path, architecture and
baseline; tracked non-Nix edits invalidate it too. Plain-directory flakes and
relative path inputs keep local caches. A failed flake rebuild retains previous
tools, prints Nix's final error, and writes the full log to the tools-cache
`error` file named in that message. The same inputs are not evaluated again for
60 seconds, so a broken definition does not cost an evaluation per command;
edits retry immediately. Devenv reads the working tree directly and needs
neither behaviour. Failed devenv entry stops the
requested operation; use the baseline override for recovery. Project tools and
the baseline remain on PATH in either backend, including managed login shells.
Custom startup files remain user-owned; only the generated startup is upgraded.

Familiar profiles share jj user settings read-only, but keep jj's writable `repos` and `workspaces` configuration metadata in the private home. That metadata binds to repository paths and must not be shared with the host's view of the checkout.

Nested shells retain PATH entries added inside the workspace, including package-manager executables for install scripts. Refreshing Nix tools replaces the previous Nix paths while keeping those additions. Initial activation still starts from the baseline, without inheriting the host PATH.

Each workspace has a private network namespace with normal outbound networking. `agent-service run preview --port 3000 --publish -- node server.mjs` allocates a host port and forwards it to this workspace's port 3000. Services must listen on `0.0.0.0` inside the namespace. `$PORT` is the internal port; the host's selected port is an implementation detail. The bridge translates service paths, ids and ports back into the workspace view. Published URLs use the Tailnet route; `agent-service verify NAME` checks the service from the host and avoids public-DNS failures inside the private network. The explicit host gateway is `10.0.2.2`; T3 maps its own loopback MCP endpoint there. This gateway does not make host services confidential.

Workspace commands also share a private PID namespace, so native process controls
and PID files identify the same processes from separate terminals. A small init
reaps orphaned children. Its runtime directory is fresh on each namespace start;
devenv caches and application data remain in the checkout. Each command has its
own systemd scope, which is stopped on command exit or cancellation. Preview
scopes are also bound to their owning agent-service unit.

Provider processes and app services run in a per-environment systemd slice, currently limited to 8 GiB and 2048 tasks with CPU weight 50. `retire` unpublishes and stops registered services, the bridge, and that slice. It retains the checkout, private home, profile, registration and changes; entering again starts it again. T3 hides workspaces after their last thread settles or archives, but keeps the files and runtime registration. Searching or showing settled workspaces finds them again. Preview leases run independently. Explicit workspace deletion retires the runtime before removing the checkout and refuses active or running member threads.

Choose a new workspace in T3, or have an agent launch a thread into one. Linux servers with the configured launcher select this runtime automatically. Advanced setup chooses Familiar (the default) or Minimal. Existing workspaces can be selected in the composer. T3-owned forks preserve the source `t3.json`; legacy CLI experiment forks still set local thread defaults. T3 keeps host workspace identity while provider protocol cwd and file references use namespace paths. Media/editor reads resolve through that workspace's registration, including `/tmp` and publication files. This also repairs private scratch-image reads for existing separate projects. SSH uses the same `agent-exec exec` entry point.

The focused derivation checks include real jj fork/collection with unfinished destination work, path separation, and environment refresh/failure behaviour: `nix build .#agent-exec`.
