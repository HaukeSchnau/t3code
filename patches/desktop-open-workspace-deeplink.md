# Desktop workspace deeplink

## Goal

Open a local directory in the desktop app from a terminal with a custom URL and `open`. Upstream
offers `t3 app <path>` but registers no URL for it.

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
- `DesktopClerk.configure` registers the schemes and handles `open-url` and `second-instance`,
  because upstream's Clerk bridge owns the single-instance lock. The deeplink check runs after
  upstream's provider-auth handlers, and only a handled URL calls `preventDefault`. Removing the
  Clerk bridge also removes deeplink delivery.
- Links that arrive before Electron is ready wait in a queue. `layerAppActivationDelivery`, wired
  in `main.ts`, sends each one through `DesktopAppActivation.request` as an `open-workspace`
  request. That is upstream's broker for `t3 app <path>`. It holds the request until the renderer
  is ready, finds or creates the project in the primary environment, and opens a new thread.
  `DesktopAppActivation.ts` only adds the `request` method to the service.
- Source launches (`apps/desktop/scripts/electron-launcher.mjs`) declare the app scheme and `t3`
  in their Info.plist. Packaged builds declare only `t3code` and `t3code-dev` through
  `scripts/build-desktop-artifact.ts`, and macOS only honors runtime registration for schemes the
  Info.plist declares. `t3://` therefore reaches source launches only.

## Non-goals

- No routing to remote environments.
- No relative paths.

## Removal

Retire this patch when upstream's desktop app handles an open-directory URL.
