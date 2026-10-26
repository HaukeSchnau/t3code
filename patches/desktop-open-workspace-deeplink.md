# Desktop workspace deeplink

## Goal

Open a local directory in the desktop app from a terminal with a custom URL and `open`. Upstream
offers `t3 app <path>` but registers no URL for it. Its own links (`t3code://new?prompt=…` and
`t3code://threads/…`) open a prompt or a thread, not a directory.

## Supported URLs

```bash
open "t3code://open?cwd=$PWD"
open "t3://open?cwd=$PWD"
```

Development builds use `t3code-dev://` in place of `t3code://`. Percent-encode `cwd` when the
path contains spaces or other URL-sensitive characters.

## Implementation

- `apps/desktop/src/app/DesktopOpenWorkspace.ts` parses `<scheme>://open?cwd=<path>` for
  `t3code`, `t3code-dev` and the legacy `t3` scheme. `dispatchUrl` answers synchronously, because
  Electron's handlers decide on the spot whether to call `preventDefault`.
- Upstream's Clerk bridge registers the app scheme (`t3code` or `t3code-dev`) as the default
  protocol client. `DesktopClerk.configure` checks every URL upstream's handlers see: the
  launch arguments, `open-url`, and second launches, which upstream buffers until `configure` runs.
  The deeplink check runs after upstream's provider-auth, web and prompt link handlers, and only a
  handled URL calls `preventDefault`. Removing the Clerk service also removes deeplink delivery.
- Links that arrive before Electron is ready wait in a queue. `layerAppActivationDelivery`, wired
  in `main.ts`, sends each one through `DesktopAppActivation.request` as an `open-workspace`
  request. That is upstream's broker for `t3 app <path>`. It holds the request until the renderer
  is ready, finds or creates the project in the primary environment, and opens a new thread.
  `DesktopAppActivation.ts` only adds the `request` method to the service.
- Nothing registers `t3` at runtime. macOS source launches
  (`apps/desktop/scripts/electron-launcher.mjs`) declare it next to the app scheme in the
  Info.plist they register with LaunchServices. Packaged builds declare only `t3code` and
  `t3code-dev` through `scripts/build-desktop-artifact.ts`. `t3://` therefore reaches macOS source
  launches only.

## Non-goals

- No routing to remote environments.
- No relative paths.

## Removal

Retire this patch when upstream's desktop app handles an open-directory URL.
