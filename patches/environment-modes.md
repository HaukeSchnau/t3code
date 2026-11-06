# Environment modes

A mode is a named set of saved environments. Applying one switches its environments on and
switches off environments that only other modes name, through the existing per-environment
`setEnabled`. **All environments** switches on everything any mode names, and environments in no
mode keep their switch. The maintainer uses this to move between a work environment and several
personal ones with one shortcut. Upstream has only the per-environment switch.

## Requirements

- Modes live per device in the connection catalog document (`environmentModes`), next to
  `disabledEnvironmentIds`. Nothing crosses the wire, so the server and contracts schemas are
  untouched apart from the `environments.cycleMode` keybinding command (default `mod+alt+e`).
- The active mode is derived from the switches (`activeEnvironmentMode` in
  `packages/client-runtime/src/connection/environmentModes.ts`), so a manual switch shows as
  Custom without extra state.
- Platform environments (the desktop's local backend and the page's primary) keep their switch in
  memory only, so the web editor offers only the environments Connections settings lists.
- Web and desktop switch modes from the sidebar footer, the command palette, and the shortcut.
  iOS shows a mode pill in the thread list filters, Android a submenu in the home header menu.
- Switching an environment off does not unregister the phone's push registration, so a
  switched-off environment that owns the registration still sends notifications.

Remove this when upstream ships grouped environment switching on every client.
