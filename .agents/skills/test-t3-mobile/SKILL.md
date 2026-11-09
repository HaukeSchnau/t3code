---
name: test-t3-mobile
description: Test T3 Code's native iOS and Android app through its Device panel and returned AgentDevice command. Use for mobile verification, native-client builds, Metro launch, and mobile pairing against isolated development state.
---

# Test T3 Mobile

## Open the device

Call `device_list`, then `device_open` with the selected host and device IDs.
T3 boots the device and shows its live stream in the Device panel. Follow its
returned `quickStart`, using the exact `agentDevice.command` and all `targetArgs`
on every operation. Use `device_screenshot` to inspect the screen.

If T3 device tools or the selected device are unavailable, report the blocker
and stop verification. Do not install or switch to another automation system.

## Start a session

When the device runs on another host (the m1 builder), run from the root of
the checkout under test, in the background, with the returned executable and
target arguments stored in `agent_device_command` and the Bash array
`agent_device_target_args`:

```bash
.agents/skills/test-t3-mobile/scripts/start-session.sh m1 \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It starts an isolated backend (`dev:server` on this checkout's `.t3`) and
Metro, tunnels both to the device host over compressed SSH, installs the dev
client for this checkout's native fingerprint, opens it against Metro and
pairs it. It prints `Ready.` with the backend port and base dir, then keeps
both servers running until you stop it. Metro serves your edits with Fast
Refresh; rerun the script after a native change. A run takes 2 to 10 minutes, mostly bundle transfer over m1's uplink;
its logs are in `.t3/mobile-session/`.

The device host builds the client in `~/Developer/t3code-mobile-session`, which the
script syncs from this checkout under a lock. CI builds the clients for main's
fingerprint there (`native-clients` in `.calder/ci.ts`), so install takes
seconds unless the branch changes native code; then the first run builds once
(5-15 minutes, through `builder-control`).

The app refuses a pairing for an environment it already saved under another
URL. On a reused simulator, remove that environment in the app, or reset it
with `xcrun simctl uninstall <udid> dev.schnau.t3code.dev` and
`xcrun simctl keychain <udid> reset` on the device host.

## Run the steps by hand

Use these for a device on this machine, or when the session script does not fit.

### Isolated backend

Reuse this task's healthy backend. Otherwise run `vp run dev` from the
repository root, retain its terminal session, and read the actual backend port
from the dev-runner output. Use the worktree's ignored `.t3` state. Never run
against `~/.t3/userdata`. The Browser panel is not required for this workflow.

Test with meaningful project and thread data. Read the shared
[SQLite fixture reference](../test-t3-app/references/sqlite-fixtures.md) only
when inspecting or seeding SQLite. Stop the test server before fixture writes.

### Launch T3 Code Dev

From the checkout being tested on the selected device host, run:

```bash
vp run mobile:install <ios|android> <device-id>
```

This installs the dev client for the checkout's native fingerprint from the
device or the local cache in seconds, building once only when the host has no
client for that fingerprint (5-15 minutes, logged to the file it names). The
device id may be omitted when exactly one device is booted. It prints one JSON
line; on failure it names the next command. Authorized mobile verification
includes that step unless the user prohibits it.

For a device you opened in an agent-device session elsewhere (a device pool,
cloud, or remote host), run `vp run mobile:install <ios|android> --session <s>`
from the directory you opened the session in. It installs the cached build into
that session (`--abi arm64-v8a` for an ARM Android device; `--metro <url>` also
opens it against Metro) and never builds.

Start `vp run dev:client` from `apps/mobile`, or reuse a healthy Metro belonging
to this checkout. Open its printed development-client URL with AgentDevice
`open <app-id> <url>` and all returned target arguments. The app id is
`dev.schnau.t3code.dev` on iOS and `com.t3tools.t3code.dev` on Android
(`scripts/lib/mobile-app-ids.ts`). The device must be able to reach both Metro
and the isolated backend.
Append `&disableAutoLaunch=1&disableFab=1` to the development-client URL query
when developer chrome would obscure screenshots or taps; the SDK 58 dev client
applies these preferences before the app loads.

### Pair

Once the app shows its home screen, run from the repository root:

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  <server-port> <base-dir> <device-reachable-backend-origin> \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It issues a fresh credential, opens T3 Code Dev's pairing route through
AgentDevice and waits until the app used it; it exits non-zero after 30
seconds without, and a rerun issues a new credential. For a backend on the
device host, use `http://127.0.0.1:<server-port>` on iOS or
`http://10.0.2.2:<server-port>` on Android. For a remote backend, use its
reachable origin.

## Verify

Confirm the intended projects appear, exercise the affected flow, and capture
evidence. Retain the app and environment while iterating. At teardown, remove
the disposable connection, close the AgentDevice session, call `device_close`,
and stop only your backend and Metro processes (or the session script).
