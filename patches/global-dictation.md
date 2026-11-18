# Global dictation key

## Fork requirement

The macOS desktop app dictates with one key (Fn by default, or Right Option or Right Command),
inside T3 and, when the person allows it, in any other app. Text lands where the press started:
a T3 composer, or the cursor of the other app, pasted if that app is still in front and copied
otherwise. Fn+Shift saves the transcript as a no-project draft thread without opening it.
Fn+Control speaks an instruction that rewrites the selection or writes at the cursor. Upstream only
has the in-app `composer.dictation` chord.

## Constraints the code can't show

- The key watcher (`apps/desktop/src/dictation/MacDictationKeyProcess.ts`) polls hardware state
  from `osascript`, which needs no Input Monitoring grant. `CGEventSourceSecondsSinceLastEventType`
  only updates twice a second, so chords such as Fn+Delete are found by scanning
  `CGEventSourceKeyState` while the key is down. Arrow and navigation keys raise the Fn bit with the
  keypad bit; that is not an Fn press. Chord keys arrived up to 285 ms after Fn on a MacBook, so a
  recording starts on a tap's release or after 300 ms held alone.
- Recording runs in the main window's renderer (`DictationKeyCoordinator`), so dictating in other
  apps needs T3's window open. A closed window shows a notice instead of opening one, which would
  steal focus from the app being dictated into.
- Pasting and field reads run as short `osascript` helpers (`MacDictationTarget.ts`) that inherit
  T3's Accessibility grant. The paste snapshots every pasteboard item, marks its own write
  transient for clipboard managers, posts ⌘V, and restores the snapshot unless something else was
  copied meanwhile.
- Electron and Chromium apps expose no focused text through Accessibility until their own
  accessibility mode is on. T3 does not switch it on (`AXManualAccessibility`), because it slows
  those apps until they restart; command mode falls back to ⌘C to read a selection there.
- `intent: "command"` on transcript cleanup is gated on the `voiceCommands` environment
  capability. An older server ignores the field and would clean the instruction up as text.

## Removal

Retire this patch when upstream ships a desktop dictation key that works outside the app with the
same destination rule, or drop the parts upstream covers.
