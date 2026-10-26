# Browser-safe thread shortcuts

## Fork requirement

Browser builds must leave native tab navigation to the browser while retaining keyboard access to
thread and model-picker navigation. The desktop client keeps the native app shortcuts.

## Defaults

- Desktop uses `mod+1` through `mod+9` and `mod+shift+[` / `mod+shift+]`.
- Browsers on macOS use the same keys with `ctrl`.
- Browsers on Windows and Linux use the same keys with `alt`.

`clientSpecificKeybindings` in `packages/shared/src/keybindings.ts` expands each default into those
three rules. The web keybinding context (`apps/web/src/keybindings.ts`) exposes optional `desktop`,
`browser`, and `mac` next to upstream's `isDesktop` and `isWeb`. `resolveContext` derives them from
`isDesktop`, `isWeb`, and the platform, so call sites leave them out. Startup migration replaces exact copies of the former
client-agnostic defaults in `keybindings.json`; user-defined rules remain unchanged. Upstream now
scopes `mod+1` through `mod+9` to `isDesktop`, but gives browsers no alternative and leaves
`mod+shift+[` / `mod+shift+]` unscoped.

Upstream's `navigation.back` and `navigation.forward` (`mod+[` / `mod+]`) keep upstream's defaults in
both clients when they arrive with a sync. They call `window.history.back()` and `forward()`, and
browsers that bind these keys at all bind them to the same history navigation. Remap a new upstream
default for browsers only when it would take over a browser shortcut for a different action.

## Maintenance

Retire this patch if upstream adopts client-aware defaults that do not claim browser tab shortcuts.
