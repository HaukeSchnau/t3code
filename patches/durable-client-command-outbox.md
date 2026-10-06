# Durable client command outbox

## Why this patch exists

Hauke works from trains. The connection drops for minutes at a time, and a socket can die after a
request left but before its reply arrived. Upstream web refuses to send while the environment is
disconnected ("Not connected: message not sent"). When a send fails in flight, it puts the text
back into the composer, and sending it again mints a new command id, so a message the server did
accept arrives twice. Upstream mobile keeps its own outbox (`apps/mobile/src/state/thread-outbox*`);
web and desktop have none.

## Requirement

- A web or desktop send made while the environment is unreachable is saved on the device, survives
  reloads, and is delivered automatically once the environment is back.
- A send whose reply was lost keeps its command id and is retried with it. The server's command
  receipts make the retry a replay, for `message.dispatch` in the orchestrator and for
  `launchThread` in `ThreadLaunchService`, so the message arrives once, also after a server restart.
- Each thread delivers in order. A message still waiting in the outbox holds back later sends to the
  same thread, including sends made after the connection returned.
- The thread shows each waiting message and its state. A message that cannot have arrived can go
  back into the composer or be discarded. A rejected one can also be retried under a new command id.
- Queue or steer stays the user's choice. The message carries it and the server resolves it against
  the thread when the message arrives.
- Attachment bytes stay on the device until an upload succeeds.

## Design

Mobile's outbox was not generalized. It stores composer intent and is tied to mobile composer
drafts, Expo files, and React Native hooks; sharing it would mean moving upstream mobile code into
client-runtime. Web needs storage that several tabs can change at once. The fork therefore keeps a
small delivery state machine in `packages/client-runtime/src/state/commandOutbox.ts` (export
`./state/command-outbox`), and web supplies storage, delivery, and UI. Mobile is unchanged.

### State machine

- Entries are `Pending`, `Delivering`, `Retrying`, or `Rejected`. The store assigns increasing ids,
  and only the oldest entry of a thread can be delivered. A waiting or rejected head holds back its
  thread and no other.
- A failure is `transient` (the command never left the client), `ambiguous` (it may have arrived,
  so only a retry with the same id is allowed), or `permanent` (the environment decided). Unknown
  errors count as permanent, so a client bug cannot block a thread forever. The thread view removes
  any entry whose message the server already shows, which also cleans up a "rejected" message that
  in fact arrived.
- Only `Pending`, transient `Retrying`, and `Rejected` entries can be taken back. Retrying a rejected
  entry assigns a new command id, because the old one replays its rejection.
- A drain runs under a lock shared by everything that uses the store. Holding it proves that a stored
  `Delivering` entry was abandoned by a reload or closed tab, so the drain turns it into an immediate
  ambiguous retry.
- The store contract is an atomic read-modify-write per entry and an add that rejects a command id
  already stored.

### Web and desktop

- `apps/web/src/durableCommandOutbox.ts` stores one IndexedDB record per entry in the database
  `t3code:thread-outbox`. Each transition is one transaction, so tabs never overwrite each other's
  work. Web Locks let one tab drain at a time, and a BroadcastChannel tells the other tabs to reload.
  The v1 fork database `t3code:durable-command-outbox` is left alone: its commands cannot be
  delivered to a v2 server.
- The drain wakes on enqueue, when an environment with waiting entries reconnects, on `online`, when
  the page becomes visible, and on retry timers. It delivers only to connected environments.
- `apps/web/src/durableCommandOutboxDelivery.ts` uploads each attachment that has no upload id yet
  and records the id before continuing, so a retry does not upload it again. It brings an existing
  thread's runtime and interaction mode in line with derived command ids (`<id>:runtime-mode`,
  `<id>:interaction-mode`), then calls the shared `startThreadTurn` with the stored command id. That
  dispatches `message.dispatch` for an existing thread and `launchThread` for a new one.
- Message context follows the environment's capability at each attempt. A receipt replay ignores the
  payload, so a capability change between attempts cannot cause a second delivery.
- `ChatView` gives its direct send an explicit command id. When that send fails with a transport
  error or an interruption, `handOffUnconfirmedSend` stores it under the same id instead of restoring
  the composer. A failure the server decided keeps upstream's restore behavior.
- The first message of a draft stores its launch and marks the draft as promoting. The draft then
  survives reloads, and new-thread actions open a fresh draft. Later sends from that draft join the
  thread as follow-ups. Editing the launch message reopens the draft.
- Sends that are not replayable keep their online requirement: starts with several models, edits
  of a queued run, plan follow-ups, answers to pending questions, compact, and resume.

## Upstream hooks

- `apps/web/src/components/ChatView.tsx`: the thread's outbox entries and the `offlineSendsQueue`
  flag; the offline toast only when a send cannot queue; the composer's disconnected state only when
  a send cannot queue; the outbox branch before uploads; the explicit command id and handoff on the
  direct send; `restoreOutboxMessageToComposer`; and the `DurableOutboxStrip` mount below
  `TrainNetworkStatus`.
- `apps/web/src/routes/_chat.tsx`: mounts `DurableOutboxDelivery`, which starts delivery for the
  session and shows a toast with an Open action when a message is rejected.
- `packages/client-runtime/package.json`: the `./state/command-outbox` export.

## Known limits

- The server sweeps pending uploads after 24 hours, and it claims attachments before it checks
  receipts. An unconfirmed message with attachments that is retried after that window shows as
  rejected even if its first attempt arrived. Opening the thread removes it once the message shows;
  retrying it by hand could duplicate it.
- A new thread that is still waiting has no sidebar row. A rejection raises a toast that opens it.
- Entries for an environment removed from the device stay in IndexedDB.

## Removal

Retire this patch when upstream web keeps unsent and unconfirmed sends on the device under a fixed
command id, delivers them in order after reconnecting, and shows them in the thread.

## Verification

- `packages/client-runtime/src/state/commandOutbox.test.ts`: offline enqueue and delivery, lost
  acknowledgement retried with the same id and accepted once, per-thread order, rejection at the
  head with retry and discard, reload during delivery, duplicate command ids, recorded uploads, and
  settling entries the server already holds.
- `apps/web/src/components/chat/durableOutboxPresentation.test.ts`: which states can be taken back
  and what the thread shows.
