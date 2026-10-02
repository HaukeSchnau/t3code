# Apple Watch

## Fork requirement

Keep an eye on agents from an Apple Watch: see which threads need attention, read where an agent
stands, answer it, tell it what to do next, or stop it. Upstream has no watch support beyond
mirrored iPhone notifications and the Live Activity in the Smart Stack.

## Status

The server endpoints the watch reads ran on v1 orchestration and were not ported to orchestration
v2. The watch app and the phone bridge still ship, but the thread list, the thread summary,
replies and Stop all fail until the port lands. The v1 implementation is in fork commit
`49e8d42dbd`: `apps/server/src/orchestration/threadGlance.ts`, the `glance` and `threadGlance`
handlers in `orchestration/http.ts`, and the `ThreadGlance*` schemas in
`packages/contracts/src/agentAwareness.ts`.

## Implementation

- The watch talks to T3 Code servers through the paired iPhone, which already holds the saved
  connections and reaches the tailnet. The watch never holds a credential of its own.
- On the phone, `modules/t3-agent-notifications/ios/WatchBridge.swift` answers WatchConnectivity
  requests natively, with the saved connections the notification reply handler already reads, so
  React never starts for the watch. Replies the watch can't deliver queue with
  `transferUserInfo` and go out when the phone is back in reach.
- The bridge asks every saved environment for `GET /api/orchestration/glance` and merges the
  lists. It reads one thread from `GET /api/orchestration/threads/:threadId/glance`. Answers and
  follow-ups go through the [notification reply](notification-replies.md) endpoint. Stop posts a v1
  `thread.turn.interrupt` command to `/api/orchestration/dispatch`, which v2 no longer serves.
- The watch app is SwiftUI in `apps/mobile/targets/watch`, generated into the Xcode project by
  `@bacons/apple-targets` at prebuild and embedded in the iPhone app, so TestFlight carries it.
  Personal-team builds skip it. `fingerprint.config.js` hashes `targets/`, otherwise a watch-only
  change would keep the runtime version and never ship. `pnpm-workspace.yaml` moves apple-targets
  onto Expo 58's prebuild-config and declares what its plugin, and expo-quick-actions', require
  without listing. Otherwise hoisting decides whether prebuild finds them, and CI broke that way.
- The watch app registers the same notification categories as the iPhone and forwards Reply and
  Retry to the phone, because a mirrored notification's action may reach the watch app once it is
  installed.

## Porting the endpoints to v2

- The list keeps v1's selection: everything that needs the user or is working, plus finished
  threads from the last day that aren't settled, attention first. Build each row from the v2 shell
  with upstream's `projectThreadAwarenessV2`, so the watch, notifications and the Live Activity
  agree about a thread.
- The thread summary takes its excerpt from the shell's `latestVisibleMessage`, its question from
  the pending runtime request (the same single-question rule as the reply endpoint), and `canStop`
  from an active run.
- Stop needs a new HTTP endpoint, because v2 has no HTTP endpoint for thread commands. It can
  dispatch `run.interrupt` with the shell's `activeRunId`, and `WatchBridge.swift` then posts to it.

## Upstream maintenance

Drop this patch if upstream ships watch support with an equivalent server-side summary.
