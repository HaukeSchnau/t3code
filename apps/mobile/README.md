# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

## Development

Start Metro for the dev client:

```bash
bun run dev:client
```

From the repo root, the `Justfile` has wrappers for the physical iOS dev loop:

```bash
just mobile-dev
just mobile-dev-server
just mobile-dev-open
just mobile-dev-reload
just mobile-dev-snapshot
```

The `agent-device` wrappers pass the signing settings needed by the iOS runner. Override the defaults with:

```bash
T3CODE_IOS_DEVICE="My iPhone"
T3CODE_APPLE_TEAM_ID="ABCDE12345"
T3CODE_AGENT_DEVICE_IOS_BUNDLE_ID="dev.example.agentdevice.runner"
T3CODE_AGENT_DEVICE_SESSION="t3dev-physical"
T3CODE_MOBILE_METRO_HOST="192.168.1.10"
```

`just mobile-dev-open` infers `http://<en0 address>:8081` when possible. Pass a URL explicitly when using another interface:

```bash
just mobile-dev-open http://192.168.1.10:8081
```

For remote-pairing debugging, start Metro with a fresh one-time pairing URL and the dev client will fill and submit the Add Environment screen automatically:

```bash
just mobile-dev-server 'https://example.com/pair#token=REPLACE_ME'
```

This avoids physical-device text-entry flakiness during `agent-device` runs. Always generate a fresh token for each run; pairing URLs are credentials and should not be committed or pasted into logs.

### Physical-device debugging notes

- Prefer `just mobile-dev-open`, `just mobile-dev-reload`, and `just mobile-dev-snapshot` over hand-written `agent-device` commands. They keep the session name, physical device, Team ID, and runner bundle ID aligned.
- If `agent-device` cannot snapshot a physical iPhone, check runner signing first. The wrappers set `AGENT_DEVICE_IOS_TEAM_ID` and `AGENT_DEVICE_IOS_BUNDLE_ID`; override them with the env vars above when using another Apple account or runner bundle.
- When debugging remote environments, keep the Metro log visible. Warnings such as `Unknown request tag: ...` usually mean the dev client is newer than the deployed remote server.
- A project list can load even if the Environments sheet briefly shows a transport error. After reconnect-related changes, use the environment refresh button, wait a few seconds, then snapshot again to catch sticky status regressions.
- `agent-device network dump` depends on active session log capture and can be empty on physical iOS runs. Treat snapshots and Metro logs as the primary signal unless log capture has been explicitly started and verified.

Build and run the local iOS dev client:

```bash
bun run ios:dev
```

Build and run the local iOS preview app:

```bash
bun run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript bun run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
bun run config:dev
bun run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

Create a cloud dev-client build:

```bash
bun run eas:ios:dev
```

Create a persistent preview build:

```bash
bun run eas:ios:preview
```

Android equivalents:

```bash
bun run eas:android:dev
bun run eas:android:preview
```
