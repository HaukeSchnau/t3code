# Apple Watch

## Fork requirement

Keep an eye on agents from an Apple Watch: see which threads need attention, read where an agent
stands, answer it, tell it what to do next, or stop it. Upstream has no watch support beyond
mirrored iPhone notifications and the Live Activity in the Smart Stack.

## Implementation

- The watch talks to T3 Code servers through the paired iPhone, which already holds the saved
  connections and reaches the tailnet. The watch never holds a credential of its own.
- On the phone, `modules/t3-agent-notifications/ios/WatchBridge.swift` answers WatchConnectivity
  requests natively, with the saved connections the notification reply handler already reads, so
  React never starts for the watch. Replies the watch can't deliver queue with
  `transferUserInfo` and go out when the phone is back in reach.
- The bridge asks every saved environment for `GET /api/orchestration/glance` and merges the
  lists. It reads one thread from `GET /api/orchestration/threads/:threadId/glance`. Answers and
  follow-ups go through the [notification reply](notification-replies.md) endpoint, and Stop posts
  to `POST /api/orchestration/threads/:threadId/stop`.
- The server side is `apps/server/src/threadControl/ThreadControl.ts`. The list holds every thread
  that needs the user or is working, plus unsettled threads that finished within the last day,
  attention first. Each row comes from the v2 shell through upstream's `projectThreadAwarenessV2`,
  so the watch, notifications and the Live Activity agree about a thread. The thread summary takes
  its excerpt from the latest run's last agent message, because shell rows carry no message text,
  and its question by the reply endpoint's single-question rule. Stop dispatches `thread.stop`,
  the command behind the app's Stop button, so it also ends background work.
- The watch app is SwiftUI in `apps/mobile/targets/watch`, generated into the Xcode project by
  `@bacons/apple-targets` at prebuild and embedded in the iPhone app, so TestFlight carries it.
  Personal-team builds skip it. `fingerprint.config.js` hashes `targets/`, otherwise a watch-only
  change would keep the runtime version and never ship. `pnpm-workspace.yaml` moves apple-targets
  onto Expo 58's prebuild-config and declares what its plugin, and expo-quick-actions', require
  without listing. Otherwise hoisting decides whether prebuild finds them, and CI broke that way.
- The watch app registers the same notification categories as the iPhone and forwards Reply and
  Retry to the phone, because a mirrored notification's action may reach the watch app once it is
  installed.

## Upstream maintenance

Drop this patch if upstream ships watch support with an equivalent server-side summary.
