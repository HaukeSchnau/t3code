# iOS native end-to-end validation

## Goal

Validate APNs notifications, Live Activities, and the custom iOS content surfaces on Hauke's
physical iPhone. Fix every reproducible issue, add focused regressions where practical, and
install a verified build.

## Scope

- APNs permission, device registration, notification delivery/tap routing, and foreground,
  background, locked, and terminated behavior.
- Live Activity start, update, end, disable, and recovery behavior on Lock Screen and Dynamic
  Island.
- Native composer, selectable markdown, review diff, and Ghostty terminal rendering/input.
- Physical iPhone is the source of truth; simulator checks are supplementary.

## Current state

- Upstream through the `v0.0.33` preparation change was merged in dedicated sync changes before
  the final device pass.
- The previously fixed medium home widget rendered its authoritative idle state on-device.
- Account authentication is now removed from the fork's clients. Pairing credentials remain the
  trust boundary for each environment.
- Signed development and Release builds are installed on the physical iPhone. The Release build
  uses sandbox APNs for direct Xcode installation and has upstream Expo OTA delivery disabled.
- Apple APNs provider key `LLC3MC4S8K` is configured on the production server for team
  `2243J9RD68`; the private key remains outside this repository.
- Real APNs delivery, Dynamic Island updates, the expanded Lock Screen Live Activity, and remote
  Live Activity end have been exercised successfully on the physical iPhone.
- The repeated-completion fix and synchronized deploy lock are pushed on fork `main`. The matching
  NixOS generation is active on `srv-2`; its production T3 process restart is safely deferred until
  the server reports no active agent work.

## Plan

1. Inventory signing, relay, notification, Live Activity, and native-surface test hooks.
2. Build and install the current source on the physical iPhone with focused device logging.
3. Exercise APNs and Live Activity state transitions end to end through the real relay.
4. Exercise each native content surface against real thread/project data and stress inputs.
5. Encode failures as focused tests, implement fixes, and repeat the physical-device pass.
6. Run targeted typechecks/lint/tests, commit atomic fixes, and record remaining external blockers.

## Verification log

- Signed Release build installed on iPhone 16 Pro / iOS 27.0 with the fork bundle and app group.
- Fixed a release-only thread crash caused by a dead `composer.onSendMessage` prop. Mobile
  typecheck passes and real cached threads now open without crashing.
- Added `remote-notification` background mode. The corresponding iOS diagnostic disappeared on
  device; Expo's base delegate still emits an unused legacy `fetch` diagnostic.
- Found and fixed local Release APNs routing drift: locally Xcode-signed production variants now
  embed and register for the sandbox gateway, while distribution builds retain production.
- Selectable native markdown rendered and exposed the standard selection/copy menu.
- Ghostty accepted keyboard input, executed `printf T3_NATIVE_OK`, and rendered its output.
- Native review diff rendered a large cached diff with syntax/word highlights and scrolled on both
  axes.
- Native composer accepted multiline text, command/path completion, and file chips. Long-pressing
  a file chip incorrectly exposed image actions including Save to Camera Roll. The Swift delegate
  fix now passes the physical retest: a real `README.md` chip renders, and long-press exposes no
  image-preview or camera-roll action.
- Focused agent-awareness/native-surface tests and the mobile typecheck pass.
- `agent-device push` cannot inject notifications on a physical iPhone, so it cannot substitute
  for an APNs-provider delivery test.
- Native Apple Sign-In reaches Apple but the official Clerk tenant rejects the fork bundle's
  identity-token audience. OAuth providers likewise reject the unregistered
  `dev.schnau.t3code://callback` redirect. The user chose not to create a cloud account and approved
  replacing Clerk/T3 Connect account identity with accountless, paired-environment enrollment.
- The complete unsigned Release app and all extensions build successfully. Its embedded Expo
  config and entitlement both select sandbox APNs, and the packaged widget extension version now
  matches app version `1.0.2`.
- A clean signed Release build and both extensions build successfully under Xcode 27 and are
  installed in place on iPhone 16 Pro / iOS 27.0.
- Added paired-environment RPCs for device enrollment, Live Activity token enrollment, and current
  awareness snapshots. The server persists registrations locally and sends notification and Live
  Activity updates directly to APNs.
- Notification permission and the real device token path reach the disposable paired server. With
  no provider key configured, the switch stays off and the app reports that the server could not
  accept the device instead of claiming success.
- Live Activity enrollment falls through an unavailable production environment process to a
  second connected environment. With no APNs provider configured, the switch stays off and the
  physical device shows the actionable message: `The paired server has no APNs provider
credentials configured.`
- A real-device failure exposed that the fork was still enrolled in upstream's Expo Updates
  project. A cached upstream bundle could override freshly installed fork code. Native OTA loading
  is now disabled and the signed app's embedded fork bundle is authoritative.
- Removed Clerk/T3 Connect UI, client providers, browser OAuth entry points, mobile onboarding, and
  native account-auth dependencies. Legacy relay-managed mobile connections are dropped during
  migration; direct paired connections remain.
- Contracts, web, desktop, and mobile typechecks pass. Focused agent-awareness tests pass (20 server
  tests and 10 mobile tests), as do the desktop protocol tests. The full server typecheck reaches
  only unrelated pre-existing `CodexThreadRpcWorkflow.test.ts` fixture errors.
- Standard notification delivery without an ActivityKit token was accepted by Apple and advanced
  the server's persisted aggregate. Repeating completion in the same thread exposed a baseline bug:
  non-alerting running states were not persisted after a previous completion, suppressing the next
  completion alert. The server now persists every non-alerting aggregate and a focused integration
  regression proves two successive completion notifications are sent.
- The fixed, deployed Nix binary passed the physical-device regression with Live Activities off.
  Two delayed turns completed in the same thread; the persisted aggregate advanced from
  `2026-08-12T00:39:42.895Z` to `2026-08-12T00:41:22.479Z`, and the second completion produced a
  visible T3 notification banner on the iPhone Home Screen.
- `just verify-host srv-2` passed after activation. Live Activity Updates were restored on the
  iPhone, the disposable paired environment was removed from the app, its public route and service
  were stopped, and its state directory was moved to the remote trash.
- The Mac's temporary developer-security mode was disabled again after device automation.

## Remaining work

- No native validation remains. The activated `t3code-deferred-restart` unit will restart the
  production T3 process after this active thread becomes idle.
