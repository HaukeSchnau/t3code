# Desktop Workspace Deeplink

## Goal

Allow the macOS desktop app to open a local workspace directly from Terminal with a custom URL and `open`.

## Supported URL

Use:

```bash
open "t3://open?cwd=$PWD"
```

If the path contains spaces or other URL-sensitive characters, percent-encode the `cwd` value first.

## Requirements

- The packaged desktop app registers the `t3` URL scheme with macOS.
- The desktop main process handles `open-url` early enough for cold-start launches.
- The supported action is `t3://open?cwd=<path>`.
- `cwd` is forwarded to the existing web-side project creation/opening flow instead of duplicating project persistence logic in Electron.
- Requests received before the web app is ready are queued and replayed after startup.
- Existing projects should be reopened instead of duplicated.
- New workspaces should create the project and open a draft thread.
- The patch should stay narrowly scoped to desktop deeplink handling and avoid changing unrelated startup behavior.

## Non-Goals

- No remote-environment deeplink routing.
- No relative-path terminal context reconstruction.
- No changes to the existing command palette semantics beyond reusing the same open-project helper.
