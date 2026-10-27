# Notification replies

## Fork requirement

Answer an agent's question, or tell it what to do next, straight from an iPhone notification,
including one mirrored to an Apple Watch, without opening the app. Upstream notifications only
open the thread.

## Implementation

- `AgentReplyHandler.swift` posts `{ replyId, text }` to
  `POST /api/orchestration/threads/:threadId/reply` and reads `{ outcome, reason? }`. `outcome` is
  `answered`, `sent`, `already_delivered` or `rejected`, and a rejection gives `approval_pending`,
  `question_needs_client` or `no_matching_option`. The server decides what the text means, in
  `apps/server/src/threadControl/ThreadControl.ts`.
- The command id derives from `replyId`, and the service looks up its v2 command receipt before
  anything else. An accepted receipt answers `already_delivered`, because on a retry the answered
  question is gone and planning again would turn the answer into a message.
- A pending approval rejects the reply. A pending question with exactly one part takes the text
  as its answer through `runtime-request.respond`, matched against its options. The shell only
  names the request, so the questions come from its `user_input_request` turn item. Without a
  pending request the text goes out as `message.dispatch` with `queue_after_active`, which starts
  an idle thread or queues behind the running turn.
- The reply, stop and glance routes are their own `threadControl` HTTP group. They take the
  connection's bearer token without the orchestration protocol header, which the native code
  doesn't send, and require the same `orchestration:operate` (writes) and `orchestration:read`
  scopes as the rest of orchestration.
- The server sends question, completion and failure alerts as regular APNs notifications with a
  category (`AGENT_INPUT`, `AGENT_DONE`) and a per-thread `thread-id`. A device with a Live
  Activity gets that update without its own alert. Live Activity alerts can't carry actions, and
  the phone should buzz once per transition. Approvals keep no category and open the app.
- Questions and approvals go out with `interruption-level: time-sensitive`, so a blocked agent
  breaks through Focus. The app carries the time-sensitive entitlement; personal-team builds drop
  it along with push.
- `apps/mobile/modules/t3-agent-notifications/ios` registers the categories at launch and handles
  the actions natively, so React never starts for a reply. It reads the saved connection catalog
  from the keychain and posts inside a background task. When that fails it posts a "Reply not
  delivered" notification, with Retry when retrying can help.
- iOS secure storage lives in the keychain service `t3code.background` with `AFTER_FIRST_UNLOCK`,
  so the handler can read connections while the phone is locked. Items from earlier builds move
  there on first read, because expo-secure-store can't change an existing item's protection class
  in place.

## Upstream maintenance

Keep the keychain service and catalog key in `mobile-secure-storage.ts`, `catalog-store.ts` and
`EnvironmentConnections.swift` in agreement, and the action ids in `AgentReplyHandler.swift` and
`notificationPayload.ts`. Drop this patch if upstream ships notification actions backed by a
server-side reply path. The [Apple Watch](apple-watch.md) app reuses the reply endpoint.
