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

- Upstream `main` at `9821bca1` was merged in a dedicated change before this work.
- The previously fixed medium home widget rendered its authoritative idle state on-device.
- The prior locally signed production-shaped build used the development APNs entitlement, so it
  did not prove production APNs delivery.
- Account authentication is now removed from the fork's clients. Pairing credentials remain the
  trust boundary for each environment.

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
  a file chip incorrectly exposed image actions including Save to Camera Roll; the Swift delegate
  fix compiles and awaits installation plus physical retest.
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
- Added paired-environment RPCs for device enrollment, Live Activity token enrollment, and current
  awareness snapshots. The server persists registrations locally and sends notification and Live
  Activity updates directly to APNs.
- Removed Clerk/T3 Connect UI, client providers, browser OAuth entry points, mobile onboarding, and
  native account-auth dependencies. Legacy relay-managed mobile connections are dropped during
  migration; direct paired connections remain.
- Contracts, web, desktop, and mobile typechecks pass. Focused agent-awareness tests pass (20 server
  tests and 10 mobile tests), as do the desktop protocol tests. The full server typecheck reaches
  only unrelated pre-existing `CodexThreadRpcWorkflow.test.ts` fixture errors.

## Remaining work

- Create and download an Apple Push Notifications provider key for Apple team `2243J9RD68`, then
  configure it outside the repository. No `.p8` provider key is currently available on either host,
  so Apple-originated delivery cannot yet be proven.
- Install the accountless signed Release and dev-client builds and repeat the composer, notification,
  widget, and Live Activity pass on the physical iPhone.
