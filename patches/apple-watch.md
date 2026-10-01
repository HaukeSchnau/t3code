# Apple Watch

## Fork requirement

Keep an eye on agents from an Apple Watch: see which threads need attention, read where an agent
stands, answer it, tell it what to do next, or stop it. Upstream has no watch support beyond
mirrored iPhone notifications and the Live Activity in the Smart Stack.

## Implementation

- The watch talks to T3 Code servers through the paired iPhone, which already holds the saved
  connections and reaches the tailnet. The watch never holds a credential of its own.
- `GET /api/orchestration/glance` lists one environment's threads for the watch: everything that
  needs the user or is working, plus finished threads from the last day that aren't settled,
  attention first. The phone asks every saved environment and merges the lists.
- `GET /api/orchestration/threads/:threadId/glance` summarizes one thread: a plain-text excerpt of
  the agent's latest message, the pending question when it is simple enough to answer on the
  watch, and whether a turn can be stopped. Both endpoints reuse the shared awareness projection
  and the reply planner's question parsing, so the watch, notifications and the Live Activity
  agree about a thread.
- Answers and follow-ups go through the thread reply endpoint described in
  [notification replies](notification-replies.md). Stop dispatches `thread.turn.interrupt`.
- The watch app is SwiftUI in `apps/mobile/targets/watch`, generated into the Xcode project by
  `@bacons/apple-targets` at prebuild and embedded in the iPhone app, so TestFlight carries it.
  Personal-team builds skip it. `fingerprint.config.js` hashes `targets/`, otherwise a watch-only
  change would keep the runtime version and never ship. `pnpm-workspace.yaml` moves apple-targets
  onto Expo 57's prebuild-config and declares what its plugin, and expo-quick-actions', require
  without listing. Otherwise hoisting decides whether prebuild finds them, and CI broke that way.
- On the phone, `modules/t3-agent-notifications/ios/WatchBridge.swift` answers WatchConnectivity
  requests natively, with the saved connections the notification reply handler already reads, so
  React never starts for the watch. Replies the watch can't deliver queue with
  `transferUserInfo` and go out when the phone is back in reach.
- The watch app registers the same notification categories as the iPhone and forwards Reply and
  Retry to the phone, because a mirrored notification's action may reach the watch app once it is
  installed.

## Upstream maintenance

Drop this patch if upstream ships watch support with an equivalent server-side summary. The glance
endpoints are fork-owned additions to the orchestration HTTP group.
