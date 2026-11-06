# Focus filters switch environment modes

## Status

Idea only. Not implemented. Builds on [environment modes](../../patches/environment-modes.md).

## Summary

Let Apple Focus switch T3 Code's environment mode. Turning on the Work Focus on an iPhone would
switch T3 Code to the Work mode, and Personal Focus to Personal, with no tap in T3 Code at all.

## Likely direction

- iOS: an App Intent conforming to `SetFocusFilterIntent` with a mode parameter, shipped through
  an Expo module. The intent writes the selected mode where the JavaScript runtime applies it
  through `environmentCatalog.applyMode` on the next foreground or immediately when running.
- macOS desktop: Electron has no Focus filter API, so this needs a small native helper or an App
  Intent in a helper bundle. Do iOS first.
- A `t3code://mode/<name>` deep link on desktop and mobile is the cheap first step. It also lets
  Shortcuts, Raycast, or calendar automations switch modes.

## Open questions

- Should a Focus change also silence push notifications from switched-off environments? Today
  the environment that owns the phone's registration keeps pushing while switched off.
- Modes are per device, so the Focus filter needs modes with matching names on each device.
