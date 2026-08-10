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

This fork has no T3 Connect account or sign-in flow. Add environments by pairing directly with a
T3 Code server. Public observability configuration belongs in the repository-root `.env` or
`.env.local`, not an `apps/mobile/.env` file. See [`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
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

The repository-owned Nix entry point runs only Metro and prints the Expo Dev Client link:

```bash
nix run .#dev-mobile
```

Without managed runtime context, the shared Project Runtime allocates stable loopback endpoints for the
physical checkout. On a persistent managed development host, infrastructure runs the prebuilt
`packages.projectRuntime` adapter against the mutable checkout and supplies generic runtime context. The
repository translates the `mobile` endpoint into Expo configuration through `project-context`;
infrastructure continues to own listener allocation, hostname publication, and lifecycle policy. This
workload is independent from the repository-owned `web` dev workload, so waking Metro does not also keep
the browser stack alive. Do not start a second `agent-service` mobile server alongside it.

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
vp run ios:dev
```

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

CI uses Expo fingerprinting with the `preview:dev` profile to reuse an existing compatible build when possible, or start a new internal EAS build when native runtime inputs change. Production and default local builds continue to use the `appVersion` runtime policy.

Preview and production builds do not require account-authentication environment variables. Configure
APNs provider credentials on each paired T3 Code server instead; they are never embedded in the app.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
