# Web settings keybinding

T3 Code adds a configurable `settings.open` command with `mod+shift+,` as its default shortcut.
This gives the web client a settings shortcut without colliding with browser behavior. The desktop
app keeps its native `mod+,` menu accelerator and also inherits the configurable command from the
web client.

## Requirements

- Keep `settings.open` in the shared keybinding contract and defaults so existing installations
  receive it through the normal non-conflicting default migration.
- Dispatch the command from the app layout, including when an editor or terminal has focus. Do not
  dispatch while the command palette or keybinding capture field is active.
- Show the configured shortcut on the command palette's **Open settings** action.
- Match shifted comma by its physical `Comma` key code. Common browser layouts report the resulting
  `KeyboardEvent.key` as `<`, not `,`.

Remove this patch when upstream provides an equivalent configurable web settings shortcut.
