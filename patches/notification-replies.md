# Notification replies

## Fork requirement

Answer an agent's question, or tell it what to do next, straight from an iPhone notification,
including one mirrored to an Apple Watch, without opening the app. Upstream notifications only
open the thread.

## Status

The server half is missing. The reply endpoint ran on v1 orchestration and was not ported to
orchestration v2. The iOS and Watch code and the JavaScript still ship, so **Answer** and **Reply**
currently fail and end in a "Reply not delivered" notification. The v1 implementation is in fork
commit `49e8d42dbd`: `apps/server/src/orchestration/threadReply.ts`, the `reply` handler in
`orchestration/http.ts`, and the `ThreadReply*` schemas in `packages/contracts/src/agentAwareness.ts`.

## Implementation

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

## Porting the endpoint to v2

`AgentReplyHandler.swift` posts `{ replyId, text }` to
`POST /api/orchestration/threads/:threadId/reply` and reads `{ outcome, reason? }`. Keep that
contract. `outcome` is `answered`, `sent`, `already_delivered` or `rejected`, and a rejection gives
`approval_pending`, `question_needs_client` or `no_matching_option`. The server decides what the
text means.

1. Derive the command id from `replyId`. Before planning, look it up in `CommandReceiptStoreV2`
   (`orchestration-v2/CommandReceiptStore.ts`). An accepted receipt answers `already_delivered`. The
   check has to come first, because the answered question is gone on a retry.
2. Read `pendingRuntimeRequest` from the thread's v2 shell. An approval rejects with
   `approval_pending`.
3. A user-input request with exactly one single-part question takes the text as its answer.
   Match it against the options with the v1 `matchUserInputAnswer`, then dispatch
   `runtime-request.respond` with `answers`. Load the questions from the thread projection, because
   the shell summary carries only the request id and kind. Any other request rejects with
   `question_needs_client`.
4. Without a pending request, dispatch `message.dispatch` with
   `dispatchMode: { type: "queue_after_active" }` and a message id derived from `replyId`. It queues
   behind a running turn and starts one when the thread is idle.

## Upstream maintenance

Keep the keychain service and catalog key in `mobile-secure-storage.ts`, `catalog-store.ts` and
`EnvironmentConnections.swift` in agreement, and the action ids in `AgentReplyHandler.swift` and
`notificationPayload.ts`. Drop this patch if upstream ships notification actions backed by a
server-side reply path. The [Apple Watch](apple-watch.md) app reuses the reply endpoint.
