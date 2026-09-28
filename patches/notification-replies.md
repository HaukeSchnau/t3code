# Notification replies

## Fork requirement

Answer an agent's question, or tell it what to do next, straight from an iPhone notification,
including one mirrored to an Apple Watch, without opening the app. Upstream notifications only
open the thread.

## Implementation

- The server sends question, completion and failure alerts as regular APNs notifications with a
  category (`AGENT_INPUT`, `AGENT_DONE`) and a per-thread `thread-id`. A device with a Live
  Activity gets that update without its own alert: Live Activity alerts can't carry actions, and
  the phone should buzz once per transition. Approvals keep no category and open the app.
- `POST /api/orchestration/threads/:threadId/reply` takes free text and a `replyId`, and the server
  decides what the text means. It answers the thread's only pending question, matched to an
  option when it names one. Otherwise it becomes a message with the thread's own runtime and
  interaction modes, queued behind a running turn. Approvals and multi-part questions come back
  as a rejection the phone can explain. `replyId` becomes the command id, so a retry that finds
  its receipt reports `already_delivered` instead of answering twice.
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
`AgentReplyConnections.swift` in agreement, and the action ids in `AgentReplyHandler.swift` and
`notificationPayload.ts`. Drop this patch if upstream ships notification actions backed by a
server-side reply path. A future Apple Watch app is meant to reuse the reply endpoint.
