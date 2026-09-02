# Browser-safe thread shortcuts

## Fork requirement

Browser builds must leave native tab navigation to the browser while retaining keyboard access to
thread and model-picker navigation. The desktop client keeps the native app shortcuts.

## Defaults

- Desktop uses `mod+1` through `mod+9` and `mod+shift+[` / `mod+shift+]`.
- Browsers on macOS use the same keys with `ctrl`.
- Browsers on Windows and Linux use the same keys with `alt`.

The web keybinding context exposes `desktop`, `browser`, and `mac`. Startup migration replaces exact
copies of the former client-agnostic defaults in `keybindings.json`; user-defined rules remain
unchanged.

## Maintenance

Retire this patch if upstream adopts client-aware defaults that do not claim browser tab shortcuts.
