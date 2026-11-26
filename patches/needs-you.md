# Needs you

## Context

The user starts agents and leaves, and comes back when a thread needs them or is done. Upstream
shows a turn that ended on a question in prose as the same Completed as finished work, keeps a page
that waits for input under Working, and treats opening a thread as handling it. Only the question
tool avoids this: its thread leaves Working and shows Awaiting Input until answered. On the fork
maintainer's hosts, agents asked in prose more often than with the question tool, and 27% of those
prose asks waited over two hours or never got a reply.

## Required behavior

- An ask is something an agent needs from the user, stored on the thread with a start and an end.
  Visiting the thread never ends it; acting does.
- Two sources raise asks: a `turn_end` ask when a top-level thread's turn ends waiting on the user,
  and a `page` ask when a page asks its reader for input: `html_render` and `html_render_update`
  take an optional `ask`, one line under 120 characters (longer text is cut), and an update with
  `ask: ""` withdraws it. An update without `ask` leaves the page's ask as it is.
- An ask ends when the user sends a user-authored message to the thread (any client, a
  notification reply, a page's `t3.send`), when the user chooses No reply needed for one ask or all
  of them, when the thread is settled, when the agent withdraws a page ask, or when a newer
  `turn_end` ask replaces the open one. A later turn that ends without an ask does not end it.
  Messages from agents, the server, notifications, delegated results, scheduled prompts,
  continuations (Resume, automatic retries) and messages with no text, attachment or context do
  not end asks.
- Cancelling the queued reply that answered asks passes them to the user's next reply sent after
  the ask, or opens them again when there is none, because the agent never got the reply. An ask
  stays as it is when a newer ask, open or ended, took the same place.
- A `turn_end` ask lands only while no user-authored message arrived after its run ended, so a
  slow detector cannot raise what the user already answered. A queued reply cancelled before it ran
  does not count. Queued runs can finish out of order, so arrival and completion times decide, not
  run order: an ask never lands under any recorded ask (open or ended) of a run that ended later,
  and it replaces the open ask of a run that ended earlier. Known gap: a reply queued behind
  another run makes the detector skip the run that ended before the reply, and cancelling that
  reply later does not bring the ask back.
- A new ask brings a settled thread back. Open asks block auto-settle. A snoozed thread stays
  hidden with asks it already had, and wakes for an ask raised after it was snoozed.
- Clients decide what a thread needs with one rule, `threadNeedsYou`: the thread's own approval,
  question or secret/link request first, then a subagent's request, a guest's message, and the
  oldest ask. Run state does not matter, so a working thread whose page asks still needs the user.
  Failed runs are not needs.
- The turn-end detector classifies the final assistant message of each completed run of a
  top-level thread with the text-generation model (`textGenerationModelSelection`), at most three
  at once. It skips subagent and delegated threads, runs whose stop was requested, runs that ended
  while a request or card waited on the user (each one counts, also behind a later run's
  approval; a later run's own request does not; a sign-in request never does; as in the shell, a
  secret card counts only while its run is live; a link card the user answered after the run
  ended, such as by linking, still counts), runs without a final message, runs that set or updated a page's ask
  that the agent did not withdraw (the page's ask covers the question even once answered or
  dismissed before the run ends; each page ask records the run that last set it, and keeps its
  first raise time), and runs the user already answered. Failures are logged and
  skipped.
- T3's agent instructions tell agents to ask every decision, approval or answer with their
  question tool, including one that comes up mid-work while they keep going. The turn-end detector
  only reads the final message, so a question in an earlier message would never become a need.
- Web and mobile lists open with a **Needs you** section above Pinned: every listed thread that
  `threadNeedsYou` reports and that is not archived or snoozed, the one waiting longest first and
  needs without a start time after them. Settled and pinned threads count too. A thread there is
  not repeated in Pinned, the inbox, Working or Settled. Rows are cards with the ask's text, or the
  request kind, under the title, and a rule closes the section. On web the header collapses like
  the other shelves (open by default). The section takes no drops; its rows drag out only as chat
  context, like Working. Asks make the row status read Input, like a question, even while the
  thread works, so a web notification for "Input needed" also fires when an ask is raised.
- **No reply needed** dismisses every open ask of a thread from the web row (hover and context
  menu), the thread header menu, and the mobile row (the swipe action that replaces Settle, and
  the long-press menu). It sits next to Snooze.
- The thread view shows the thread's oldest open ask when the thread has no request of its own:
  on web as the attention line at the end of the timeline, on mobile in the status pill above the
  composer. On web a `turn_end` ask shows its text; a page ask reads "<page title> is waiting for
  you" with Open (the page's full-screen dialog) and Jump to it when the loaded timeline holds the
  page, and "A page" otherwise. The mobile pill shows the ask's text with a page or question icon.
  Both offer No reply needed for that one ask. On mobile, background work the user can stop keeps
  the pill until it ends, because the pill holds its only Stop.

- Pages: the server indexes every page `html_render` shows (one row per render, keyed by its first
  version's attachment id) with its title, first and latest publish time, newest version and version
  count. Pages shown before the index existed are not backfilled: finding them would scan the turn
  item table, which runs to gigabytes, at startup. `html_render_update` of such a page reads that
  thread's tool calls for it and indexes it with the new version, so a failed update indexes
  nothing, and refuses an id that was never a first version shown in the thread.
- A page is seen once a client showed its newest version, loaded, in view for 1.5 seconds while
  the tab or app is in front: at least half of the page on screen, or the page covering half the
  screen (a page taller than two screens is never half on screen). Opening it full screen sees it
  too. Seen is stored on the server, so
  every device agrees, and only for the version the reader saw on a thread that still exists. A
  new version clears it.
- Clients list pages by thread, waiting pages first so the list's cut never hides one, or across
  threads filtered to pages that ask, unseen pages or all, newest first and paged; each batch starts after the previous batch as it stands now. Each row
  carries the thread's title and the page's open ask. A change stream, per thread or for all
  threads, sends the page count and moves on when a page is published or seen, or a thread with
  pages has its asks, title, settling or deletion change; a list reloads only on changes in its
  scope.
- The web thread header shows **Pages** with the count and how many wait, in a popover grouped as
  waiting, new and seen; a page the loaded timeline holds scrolls into view, an older one opens
  full screen with the bridge it answers through. The closed chip reads the count from the thread's
  change stream and the waiting count from the shell's open asks; the rows load when the popover
  opens. Mobile shows the same entry in the thread screen's status row and opens a sheet. A
  **Pages** view lists every thread's pages: on web at `/pages`, from the sidebar footer and the
  command palette; on mobile as a screen opened from a row at the top of the Follow-ups tab and
  from the command palette, so the app keeps four tabs (a fifth turns on tab customization, and
  the Android tab bar shows no header actions).

- Triage goes through the threads that need you one card at a time: the threads the Needs you
  section lists, in its order. It follows the section's filters and snooze rule: on web the
  sidebar's project filter (`resolveSidebarProjectScope`, shared with `Sidebar.tsx`; a chosen
  project that has not loaded yet scopes to no thread, not to all) and a snooze
  only once the environment's config has loaded; on mobile the list's environment and project
  filters, read from the list's own layout (`buildThreadListV2Items`) under the scope the lists
  resolve (upstream's `resolveHomeProjectFilterScope`, which reads a legacy per-environment scratch
  key as "No project"). A search hides the section on both, so no search applies. A card shows the project, the thread's title, how long it waited,
  the need's text, the agent's newest message as Markdown, the page inline for a page ask (newest
  version, answering through the page bridge; looked up in the page index by thread and render id
  and mounted under that id when the loaded timeline does not hold it), and a single question's
  options. A reply box sends a
  user message, which ends the thread's asks; for a single question it sends a typed answer when
  the question allows one, built by the thread's own answer builder. Approvals, requests,
  questions with several parts and questions with text to edit (`initialAnswer`) list what they
  wait on and open the thread to answer. Actions: open the thread (pushed on both mobile
  platforms, and Android's thread Back pops to the deck below it), snooze for an hour, No reply
  needed (only with open asks).
- The deck stays on its card while other threads come and go. When the card's thread stops
  needing the user (answered elsewhere, dismissed, snoozed), the first card after it that is still
  there comes next, then the first card that was not before it, else the last. The reply typed on a
  card stays with its thread for the session; a send that lands clears it only while it still
  holds the sent text, also after triage closed; an answer cut off by an interrupt may not have
  arrived, so it keeps its draft, without an error. Replies and the page's sends go through the
  client's command outbox (web's durable outbox, mobile's thread outbox), so one sent offline or
  cut off on the way arrives once. A thread's send stays pending while the outbox has not yet read
  what it saved (`loaded`), while the send is handed over and then while the outbox holds a message
  for the thread (`holdsThread`), so Send and the question's
  options stay disabled until it settles, also across closing and reopening triage and after a
  restart that restored the message. A card whose thread shows another page starts that page at
  its newest version, without the last page's load failure. A reply takes the thread's model and
  modes as they are when it arrives, so one that waited offline never undoes a change made on
  another client meanwhile. A page's `t3.send` on a card shares the per-thread rule, also once the
  page is expanded full screen: while a send is pending it rejects with a message the page can
  show, and the page may try again. An empty deck says "Nothing needs you" with a close button.
- Web and desktop: triage is the `/triage` route, shown as an app modal over the last view like
  Settings and Usage, so `Esc` and the close button return to it, the view behind stays mounted,
  and the link works. Entry points: the `needsYou.triage` keybinding (`mod+shift+y` in desktop,
  `ctrl+shift+y` in macOS browsers and `alt+shift+y` in other browsers, since Firefox on Linux
  opens Downloads with `ctrl+shift+y`), the command palette ("Triage what needs you") and a Triage
  button in the Needs you header. Keys: plain `Enter` sends (`Shift+Enter` new line; no other
  chord and no IME commit sends), `o` open, `s` snooze, `x` No reply needed, `j`/`k` next and
  previous, `Esc` closes. Letter keys and `Esc` never act with a modifier, during IME
  composition, while typing in a field (there `Esc` leaves the field, under the same guard), or in
  a layer over the deck (a menu, the page's full screen view); a page's frame keeps its own keys. A
  held `Esc` acts once, so the one that left the field does not close triage.
- Mobile: a Triage screen (route `triage`) with the same cards, a sideways swipe between them (a
  cancelled swipe springs back and stays on the card), and buttons for Send, Open thread, Snooze
  1 h and No reply needed, opened from Triage in the Needs you header and the command palette.

### Notifications and the count

- Notifications mean "your turn". Web, desktop and the iPhone notify when a thread starts needing
  the user (an ask, a question, an approval, a guest's message, a subagent's or side chat's request
  on its parent) and when a run fails, also while an ask is open. A run's completion
  notifies only when the user started that run: a user-authored message started or steered it,
  or it continues a run the user started (after restarts or usage limits, however many in a row).
  A run that a wake, a watcher, another agent or a scheduled task started, and that ends without
  an ask, is quiet.
- Alerts come from committed events, never from what a thread shows at some later moment. The
  needs-you service reads the orchestration event stream in order from a durable cursor and
  records each alert once, as a subject keyed by what it is about: `run:<id>` when a run the user
  started completes, `run:<id>@<epoch ms it ended>` when any run fails (a run whose workspace
  preparation failed runs again under its id, and each end counts on its own, while repeated
  updates of one end do not), `ask:<id>` when an agent asks, `request:<id>` for each pending
  question, approval, secret card or link card (a subagent's approval and a side chat's request
  on their listed parent), and `guest:<id>` for a guest's message. Every thread event whose
  payload is the thread carries its asks, so an ask also ends with an event that is not its own,
  such as settling. A visit's and a pull request link's events carry no thread. A
  later run, such as a wake queued right behind the user's, a hold, an archive or a reconnect
  cannot erase or repeat one. The first start puts the cursor at the current event and keeps its
  time: what started before it is history, also when a later event repeats it, so a deploy alerts
  nothing from before it. After that, a restart reads the events it missed. Before the cursor
  passes a run's end, the service stamps the thread's `returnedAt` (`thread.return`, a no-op
  when repeated). The cursor moves only once everything a batch of events calls for (subjects,
  runs to read, return stamps) is recorded. A batch that fails, or a stream that breaks, is read
  again from the cursor, backing off up to a minute, while the minute tick goes on.
- Current state only decides whether a recorded subject still alerts: when it is recorded, when
  held work ends, and again right before each delivery. Something older than ten minutes no
  longer alerts. An archived or snoozed thread alerts about nothing, though a child thread's
  request still wakes its parent, and a failure after the snooze began wakes it, also when a later
  run such as a queued wake is the thread's latest. A need that ended no longer alerts: for a
  guest, that message was sent or dismissed, whatever other messages still wait; a secret card
  ends with its run, as in the shell. A
  completion does not alert once its run has an ask: a turn-end ask in any state, or a page's ask
  that run set unless the agent withdrew it (PR 2's rule). The completion records that it was
  superseded, for good, so No reply needed never brings it back, on the phone or on a browser
  catching up. It also does not alert once the user wrote in the thread or settled it, or while
  the thread waits on something else. A failure stays its own alert. While background work or a
  `t3_watch` watch holds a completion, it waits, also through an outage longer than ten minutes;
  its ten minutes count from the last minute it was seen held, so a long hold still ends in one
  alert, and one whose hold ended unseen, such as during an outage, alerts when it is first seen
  free.
- The ledger (migration 113) keeps the cursor, the subjects, one delivery row per device that
  wants a subject, and the completed runs the turn-end detector has to read. Subject versions,
  which browsers resume from, come from a counter on the cursor row, so pruning old subjects never
  hands a version out again. Each start prunes subjects unchanged for 30 days, but keeps needs
  still open and their reminders, so a long snooze still ends in a reminder and none reminds
  twice. One worker sends deliveries one at a time and checks each right before
  it goes out, once it holds the lock that badge and Live Activity requests share, so no delivery
  acts on state read for another or read before a request ahead of it. An ask that replaces its run's completion takes its place (the same APNs
  collapse id and web notification tag) and is quiet only on a device whose APNs accepted that
  completion; a device still waiting for the completion gets only the ask, with a sound. When a
  need ends (an ask answered or dismissed, a request resolved), its deliveries that have not gone
  out are cancelled. When APNs does not answer, the delivery counts as failed and goes out again a
  minute later, within the ten minutes: a missed "your turn" costs more than a second buzz, and
  the collapse id folds the copies on the phone. Every APNs request has a fifteen-second deadline,
  after which its HTTP/2 session is closed, so a stalled badge or Live Activity update never holds
  up an alert.
- The turn-end detector reads each completed run of a listed thread that the needs-you service
  records, by its id, so a wake queued behind it does not hide it. A read counts as done only
  after it succeeded and raised any ask. A failed read is tried again for seven and a half
  minutes, and so is a failed lookup or write of whether the run was read, each on its own, so a
  failed write does not read the run again. A start reads what was left unread in the last ten
  minutes. When reading that list fails, it is read again on the same schedule, from the last ten minutes as they are then,
  while new runs are read meanwhile.
- An ask, a pending question, approval or card, or a guest's message that still waits an hour
  after it started reminds once (`remind:<subject>`), each on its own. A need a snooze covered
  reminds an hour after the snooze ended, also when the user woke the thread early (the shell
  keeps `lastSnoozeWakeAt` after the wake clears the snooze). The server schedules reminders from
  current state each minute, so a restart after the hour still reminds, up to a day late, and a
  need snoozed for days reminds after its snooze, however long ago it started. It reads the
  thread again before recording one, so a snooze it has not seen in the events yet defers the
  reminder instead of using it up. An ask that opens
  again because the user cancelled the queued message that answered it reminds an hour after it
  opened again, also when the service reads the answer and the cancellation together, with or
  without the raise. Needs that were open before the first start do not remind.
- At 19:00 server time, if anything needs the user, one subject (`digest:<local date>`) says how
  many threads need them and names the one waiting longest. A server that was down more than 30
  minutes past 19:00 skips that day's. The hour is a constant.
- Web and desktop present the same subjects. Each environment streams the subjects it published or
  resolved in the last ten minutes (`needsYou.subscribe`); a failed read of them is retried,
  never sent as none. A browser presents each subject at most
  once: it keeps the last version it saw per environment and claims each subject, by environment
  and id (every server has its own `digest:<date>`), for two days in `localStorage` under a Web
  Lock. Only a
  tab that can present a subject claims it, through the channel it then uses: a toast in a
  focused tab, a system notification in a background one, a sound otherwise, and for reminders and
  the digest a system notification whenever those are on. When the browser refuses a system
  notification it allows, a focused tab uses its other channels. It claims the subject once it
  presented it, so one whose system notification the browser refused stays for another tab. A tab that
  cannot present it tries again when it gains focus. A subject whose thread the tab has not loaded
  yet waits for it, and so does an ask the tab's thread does not show open: the shell can show the
  answer before the stream resolves the ask, or the ask after its subject. The version the browser
  saves stays before what waits, so a reload presents it. A tab saves a version only under the claims lock, once it presented, passed over or
  set waiting every subject up to it, also when several snapshots queue behind another tab's
  claims. It reads what waits under that lock too, and never presents a version that a newer one
  of the same subject, such as its resolution, replaced, also when a later snapshot no longer
  lists the subject. A waiting subject that a snapshot no longer lists, such as an ask answered
  and cancelled in one go, presents nothing. Before presenting, a tab checks its own view of the thread (archived, snoozed,
  hidden by a tag filter; a failure after the snooze began still presents). A superseded completion
  is never presented: a browser catching up presents only its open ask, with a sound, or nothing
  when the ask ended. A browser that never watched an environment treats what it finds there as
  history.
- A server built before `needsYou.subscribe` reports the same orchestration protocol and answers
  that method as unknown. A tab then alerts about that environment from its threads as it shows
  them, as browsers did before for needs and failures: once when a thread starts needing the user
  (by thread and need, so the same need alerts again only after the thread needed nothing) and
  once per failed run. There are no reminders, no digest and no completion alerts, and what the
  tab finds first is history. An environment that answers the stream never uses this, and the
  choice holds until the page reloads.
- The inbox orders by `returnedAt`, which the server keeps on the thread: a run the user started
  ending, a run failing (`thread.return`, dispatched by the needs-you service when it sees the
  run end) or an ask being raised advances it, besides the user's own messages and unsettling.
  Quiet runs leave it alone, and they no longer unsettle a settled thread; an ask or a failure
  still does, unless the user settled the thread after the failure. Threads without
  `returnedAt` (older servers, history from before it) keep the previous rule.
- The count of threads in Needs you is state, not unread notifications. Web shows it in the tab
  title ("(2) T3 Code") and the favicon badge, desktop on the dock or taskbar icon (focusing the
  window no longer clears it). The phone's count is the server's own threads, with its subagents'
  and side chats' requests on their parents, and is the one number on the app icon (APNs `badge`
  on every alert, badge-only pushes coalesced for three seconds with `apns-expiration: 0` so they
  never replace a stored alert, retried per token when a token is new or the last push failed),
  the widget and the Live Activity (`attentionCount`, also when no row is left). While open, the
  app shows the count of the server that took its device registration, which sends its pushes,
  leaves the icon alone while it does not know that server yet, and clears the icon once no server
  is paired. The watch's list waits by the same rule: a parent waiting on a subagent's approval, a
  guest's message, snoozed threads left out. A thread's detail on the watch does too, so a parent
  waiting on a child's request offers no reply that would only reach the parent.
- A thread with open asks reads as waiting for input in agent awareness, so the Live Activity, the
  widget and the watch list it, whatever its run does. These rows only display; they never alert.

## Implementation

Fork-owned files:

- `packages/contracts/src/threadAsks.ts`: the ask entry, its source and status, the 120-character
  ask text, and the shell's open-ask summary.
- `apps/server/src/orchestration-v2/ThreadAskDecider.ts`: raise, replace, guard, withdraw,
  dismiss, answer on reply, reopen on a cancelled reply, dismiss on settle; a raise also stamps
  `returnedAt`. Pure, like
  `GuestShareDecider.ts`. Keeps every open ask and the newest resolved ones, 20 in all.
- `apps/server/src/orchestration-v2/TurnEndAskDetector.ts`: the reactor on completed runs.
- `apps/server/src/orchestration-v2/userTurn.ts`: `isUserTurn`, shared by the title refresh and
  asks, and `isUserReply`, a user turn with text, an attachment or context.
- `evals/thread-asks/`: the detector eval.
- `apps/web/src/state/htmlRenderOpenRequest.ts`: lets the ask line open a page's full-screen
  dialog, which the page's frame owns with the bridge the page answers through.
- `apps/server/src/agentAwareness/NeedsYouNotifications.ts`: the event consumer that records
  subjects, resolutions and runs to read; the count; the minute tick (held completions,
  reminders, the digest); the delivery worker; the subjects stream for clients.
- `apps/server/src/agentAwareness/needsYouRules.ts`: when a subject alerts (`subjectVerdict`),
  which listed thread a child's request waits on, reminder and digest times, and what a thread
  needs for the count (`needsYouThreads`, mirroring the clients' `threadNeedsYou` with child
  requests on their parents and snoozes from `ThreadSettlementService.isSnoozed`), which is also
  the watch list's rule.
- `apps/server/src/agentAwareness/NeedsYouLedger.ts` and
  `apps/server/src/persistence/Migrations/113_NeedsYouLedger.ts`: the cursor, subjects,
  deliveries per device and runs to read. Migration 112 is needs-you PR 2's; the migrator refuses
  to skip an id, so 112 must ship first.
- `packages/contracts/src/needsYou.ts`: the subject clients receive and `needsYou.subscribe`.
- `apps/server/src/orchestration-v2/threadReturn.ts`: who started a run (`readRunEnd`) and when its
  end returns a thread.
- `apps/mobile/src/features/agent-awareness/appIconBadge.ts`: the app icon count while the app runs.
- Tests: `ThreadAskDecider.test.ts`, `ThreadAsk.test.ts`, `TurnEndAskDetector.test.ts`,
  `NeedsYouNotifications.test.ts`.
- `packages/contracts/src/htmlRenderPages.ts`: the page row, list input and result, seen input,
  change tick.
- `apps/server/src/htmlRender/HtmlRenderIndex.ts`: the index (record, index an older page, seen,
  list, change stream) and the reactor that passes on thread events lists show; migration 112
  (`persistence/Migrations/112_HtmlRenders.ts`); `HtmlRenderIndex.test.ts`.
- Web: `components/chat/ThreadPagesControl.tsx`, `components/chat/HtmlRenderPageDialog.tsx`,
  `components/pages/` (`PagesPage.tsx`, `PageListRow.tsx`), `routes/_chat.pages.tsx`.
- Mobile: `features/pages/` (the Pages screen, the thread's Pages sheet, the page row, the
  thread pages query and route, the seen hooks, and `pagePresentation.ts`).
- `packages/client-runtime/src/state/needsYouTriage.ts` (exported as `state/needs-you-triage`): the
  deck's threads, its position (`reconcileNeedsYouDeck`, `stepNeedsYouDeck`), the session's
  drafts (`makeNeedsYouDraftStore`), `needsYouCard`, what a card offers (the newest assistant
  message, the page's versions, a single question, the reply mode, what an Open-thread card waits
  on), `needsYouPageFrame` (timeline or page index) and `needsYouAnswers` (through
  `buildPendingUserInputAnswers`). Test: `needsYouTriage.test.ts`.
- Web: `components/needsYou/` (`TriagePage.tsx`, `TriageCard.tsx`, `NeedsYouTriageButton.tsx`,
  `triageKeys.ts` with `triageKeys.browser.test.ts`), `routes/_chat.triage.tsx`.
- Mobile: `features/needs-you/` (`TriageScreen.tsx`, `triageDeck.ts` with `triageDeck.test.ts`,
  `triageSession.ts` with the session's store and the outbox sends of replies and pages).

Upstream-owned hooks:

- `packages/contracts/src/orchestrationV2.ts`: `asks` and `returnedAt` on
  `OrchestrationV2AppThread`, stored in the thread's `payload_json` with no migration; `openAsks`
  on the thread shell, present only when there are some, and `returnedAt`;
  `latestRunStartedByUser` and `lastSnoozeWakeAt` on the shell; `pendingGuestMessageAt` on the shell, so a guest's message
  sorts by when it waits; `card` on the pending request summary so clients can tell a secret or
  link card from a question; client command `thread.ask.dismiss`; internal commands
  `thread.ask.raise`, `thread.ask.withdraw` and `thread.return`; event `thread.asks-updated`,
  carrying the thread like `thread.guest-share-updated`. `baseSchemas.ts` adds `ThreadAskId`.
- `apps/server/src/orchestration-v2/Orchestrator.ts`: dispatches the ask commands, answers open
  asks in `dispatchMessage` in the same commit as the message, so every user-authored message
  answers them (sends, guest sends, an answer to a question card the agent did not wait on),
  reopens them in `queued-run.cancel`, dismisses them in `thread.settle`, refuses
  `thread.auto-settle` while asks are open, accepts ask commands that change nothing, stamps
  `returnedAt` in `thread.return`, and lets only a user's message unsettle a settled thread in
  `dispatchMessage`. `streamDomainEventsAfter` (also on `ThreadManagementService`) streams from a
  sequence, so the needs-you service resumes from its cursor.
- `apps/server/src/orchestration-v2/ProjectionStore.ts`: the event in the projection switches and
  the updatedAt list, `openAsks` and `pendingGuestMessageAt` in both shell paths,
  `latestRunStartedByUser` (`runStartedByUser`, repeated in SQL as `isUserStartedShellRun`, which
  follow continuations back to the run they continue, however many, and treat a chain that loops
  as the user's), `returnedAt` and
  `lastSnoozeWakeAt` in both shell paths, `openAsks` in the awareness snapshot and settlement
  candidates, `card` on secret and link cards, and `getLatestUserReply` (the newest
  `isUserReply` message in SQL, without cancelled queued sends), which the guard and the detector
  read instead of every run and message of the thread. Under the command lock the guard reads
  only messages after the run ended.
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts`: open asks block auto-settle; a
  newer ask ends a snooze.
- `AgentAwarenessRelay.ts`, `GuestShareService.ts`, `testkit/OrchestratorScenario.ts`, client-runtime
  `orchestrationV2Projection.ts`: the new event and command in their switches. The relay's event
  filter publishes `thread.asks-updated`.
- `TurnEndAskDetector.ts` reads the completed runs the needs-you service records instead of its
  own event subscription, marks each read once it succeeded, retries a failed read, and on start
  reads what was left unread in the last ten minutes.
- Agent awareness: `packages/shared/src/agentAwareness.ts` (open asks read as
  `waiting_for_input`, a quiet run's completion projects to nothing),
  `LocalAgentAwarenessPublisher.ts` (rows only, published as they change),
  `LocalAgentAwareness.ts` (`alertTargets` and `deliverAlert` for one device,
  `setNeedsYouCount` with coalesced and retried badge pushes,
  `attentionCount` on the aggregate, also without rows, `lastBadge` per stored device; rows no
  longer alert; a Live Activity end APNs refused for now is sent again with the next publication), `ApnsProvider.ts` (`badge`, `silent`, the collapse id hashed from a collapse key, `sendBadge` with
  `apns-expiration: 0`, and `sendApnsRequest`, which closes a request's HTTP/2 session at its
  deadline), `packages/contracts/src/relay.ts` (optional `attentionCount` on the
  aggregate, which older apps ignore), `threadControl/ThreadControl.ts` (the watch's waits by
  `needsYouThreads`), `server.ts` (one ledger for the needs-you service and the detector), and
  `ws.ts`, `auth/RpcAuthorization.ts` and `observability/RpcInstrumentation.ts`
  (`needsYou.subscribe` with the read scope). The T3 Connect relay path (off in this fork) keeps upstream's
  five-second completion confirmation; its relay decides alerts from state transitions, so
  removing the confirmation could not collapse its alerts.
- Web: `state/needsYou.ts` (the subjects of each environment), `ThreadNotificationCoordinator.logic.ts`
  (new subjects by version, the presentation channel, claims and cursors in `localStorage`, and
  for older servers `needsYouSource` and `shellAlerts`),
  `ThreadNotificationCoordinator.tsx` (presents the environments' subjects instead of deriving
  alerts from thread status changes, a notification or toast replacing only the one it takes the
  place of, the count for the favicon and dock badge, `needsYouCountAtom`),
  `threadNotifications.ts` (`threadNotificationTag` takes any subject), `appInit.tsx` (the tab
  title). The upstream grace for a background wake's completion is gone: the server decides. Desktop:
  `ipc/methods/notificationBadge.ts` no longer clears the badge on focus; the preload's
  `onNotificationBadgeClear` stays in the bridge, unused.
- client-runtime: `latestRunStartedByUser` and `returnedAt` on `EnvironmentThreadShell`, and in
  `state/threadInbox.ts` `threadsNeedingYou`, `inboxReturnTime` (by `returnedAt` when the server
  sends it; otherwise `isQuietRun` and the return tracker skipping quiet runs).
- Mobile: `AgentActivity.tsx`, `AgentActivityWidget.tsx` and `agentActivityWidgetTimeline.ts` read
  `attentionCount`; `App.tsx` installs the app icon badge, which shows the count of the server
  that took the device registration and clears it once no server is paired. That owner is kept in
  the stored registration record (`persistence/mobile-storage.ts`), so a relaunch that skips
  registering still knows it, and the snapshot and the Live Activity registration go to it. A
  cold launch reads the owner from that record before registering restores it, and a record from
  before owners were kept registers again to learn its owner
  (`readAppIconCount` in `remoteRegistration.ts`, `ownerEnvironmentIds` in
  `registrationEnvironmentSelection.ts`, `AccountlessAgentAwarenessProvider.tsx`).
- Text generation: `generateTurnEndAsk` on `ProviderTextGeneration`
  (`packages/provider-core/src/server/textGeneration.ts`), its prompt in `textGenerationPrompts.ts`,
  its operation in `textGenerationOperations.ts`, the sanitizer in `textGenerationUtils.ts`, the
  server's `TextGeneration.ts`, and every provider: Claude runs it in a temporary directory like
  titles, Codex, Muse and OpenCode implement it, and ACP Registry, Fx and Kiro report it
  unsupported.
- `packages/provider-core/src/server/orchestrationInstructions.ts`: the question-tool line, and
  `apps/server/src/provider/agentContextBudget.json` for its measured size.
- `apps/server/src/server.ts`: starts the detector next to the title refresh, and provides the page
  index once for `/mcp` and the WebSocket handlers.
- `apps/server/src/htmlRender/HtmlRender.ts`: `publish` writes the index for a page and each later
  version (a failed index write is logged; the page still shows). `mcp/toolkits/html/` adds `ask`
  to both tools and raises or withdraws the page ask after publishing, with the calling thread's
  active run, and checks with the index that an update names a page.
  `apps/server/src/provider/agentContextBudget.json` holds the larger tool list.
- RPCs `htmlRender.markSeen` (operate scope, client-guarded), `htmlRender.listPages` and
  `htmlRender.subscribePageChanges` (read scope): `WS_METHODS` and `ForkWsRpcGroup` in
  `packages/contracts/src/rpc.ts`, `clientRpcPermissions.ts`, `auth/RpcAuthorization.ts`,
  `observability/RpcInstrumentation.ts`, the fork handler layer in `ws.ts`, and
  `client-runtime/src/rpc/client.ts` (the stream tag). Migration 112 in `Migrations.ts`.
- `packages/client-runtime/src/state/htmlRender.ts`: the `pages` query (refreshed by its scope's
  change stream), the thread page count, `markSeen`, the once-per-version seen marker, the in-view
  rule both clients use, and the waiting/new/seen grouping.
- Web: `chat/HtmlRenderFrame.tsx` (marks seen on visibility and full screen; its state and bridge
  hook is shared with the page dialog), `chat/ChatHeader.tsx` and `ChatView.tsx` (the Pages chip),
  `sidebar/SidebarChrome.tsx`, `sidebar/mainAppLocation.ts`, `CommandPalette.tsx`,
  `state/htmlRender.ts`, `routeTree.gen.ts`.
- Mobile: `state/htmlRender.ts` (the seen marker), `features/threads/ThreadFeed.tsx` and
  `HtmlRenderWebView.tsx` (a page row in view for 1.5 seconds is seen),
  `features/files/AttachmentFileScreen.tsx` (opening a page full screen sees it),
  `features/threads/floating-working-control.tsx` and `ThreadDetailScreen.tsx` (the Pages segment
  above the composer), `Stack.tsx` and `features/layout/workspace-overlay-routes.ts` (the `Pages`
  and `ThreadPages` routes), `features/follow-ups/FollowUpsScreen.tsx` (the Pages row),
  `features/keyboard/CommandPalette.tsx`, `components/ui/AppSymbol.android.tsx` (`doc.richtext`).
- `apps/server/src/orchestration-v2/TurnEndAskDetector.ts`: skips a run that set a page ask, so a
  page that asks and the turn that showed it do not make two asks for one question.
  `threadAsks.ts` adds `runId` to the page source and `ThreadAskDecider.ts` moves it with the text.
- `packages/client-runtime`: `openAsks` on `EnvironmentThreadShell` (`state/models.ts`),
  `threadNeedsYou`, `threadNeedLabel`, `sortThreadsByNeed` and the inbox tracker's `actionable`
  (`state/threadInbox.ts`), snooze wakes for newer asks (`state/threadSettled.ts`),
  `dismissThreadAsks` (`operations/commands.ts`), and the `dismissAsks` command with an optimistic
  update (`state/threadCommands.ts`).
- Web sidebar: the `needs-you` section and `needs-you-header` marker in `Sidebar.logic.ts` (section
  routing, drop targets, drop verbs, and the status checks that now read `threadNeedsYou`),
  `Sidebar.drag.ts` (the section in the drag projection), `Sidebar.tsx` (partition, list items,
  header, No reply needed handler), `sidebar/SidebarListMarkers.tsx` (the header),
  `sidebar/SidebarThreadRow.tsx` (the need line and hover button), `threadActionMenu.logic.ts`,
  `hooks/useThreadActionMenu.ts`, `hooks/useThreadActions.ts` and `contextMenuFallback.ts` (the menu
  item and its icon).
- Web thread view: `askNowItem` in `chat/ThreadActivityBanners.tsx`, `chat/useThreadLifecycle.tsx`
  (the attention line after a subagent's request), `chat/useTimelineFollow.ts` (`revealHtmlRender`),
  `chat/HtmlRenderFrame.tsx` (registers to open full screen), `ChatView.tsx` (passes the timeline
  in).
- Mobile: `features/threads/threadListV2.ts` (section, ordering, status, swipe action, move
  sections), `features/threads/thread-list-v2-items.tsx` (header, need line, swipe and menu),
  `features/home/useThreadListActions.ts`, `HomeScreen.tsx`, `HomeRouteScreen.tsx`,
  `features/threads/ThreadNavigationSidebar.tsx`, and the `ask` status in
  `features/threads/ThreadDetailScreen.tsx`, `floating-working-status.ts` and
  `floating-working-control.tsx`. `components/ui/AppSymbol.android.tsx` maps `checkmark.bubble`.
- Docs: `docs/user/thread-sidebar.md` (See what needs you), `docs/user/text-generation.md` and
  `docs/user/mobile-notifications.md`.
- Triage: `needsYou.triage` in `STATIC_KEYBINDING_COMMANDS` (`packages/contracts/src/keybindings.ts`)
  and its defaults in `packages/shared/src/keybindings.ts` (through `clientSpecificKeybindings`); the
  handler in `AppSidebarLayout.tsx` (app shell commands); its label in
  `settings/KeybindingsSettings.logic.ts`; `resolveSidebarProjectScope` in `sidebarProjectGrouping.ts`
  (the sidebar's project filter, moved out of `Sidebar.tsx` so triage shares it; a chosen project
  that has not loaded yet adds no thread and sets `loading`, so a route reveal in
  `sidebar/routeReveal.ts` does not widen, and so clear, a scope still loading);
  `isImeCompositionKey` in `composer-logic.ts` (the composer's IME check, shared); an
  `escapeCloses` guard on `AppRouteModal.tsx`; `/triage` in
  `isAppModalPage` (`sidebar/mainAppLocation.ts`); the palette entry in `CommandPalette.tsx`;
  `routeTree.gen.ts`; an `action` slot on `SidebarSectionHeader` (`sidebar/SidebarListMarkers.tsx`)
  that `Sidebar.tsx` fills with the Triage button; `oldestOpenAsk` in client-runtime
  `threadInbox.ts`. Mobile: the `Triage` route in `Stack.tsx`, the palette entry in
  `features/keyboard/CommandPalette.tsx`, the header action in
  `features/threads/thread-list-v2-items.tsx`, and a `triage` flag on `ThreadHtmlRender`
  (`features/threads/HtmlRenderWebView.tsx`) that sends a card's page through triage and carries
  over to its full-screen route (`triage` on `AttachmentFileScreen.tsx`'s params, read by
  `htmlRenderRouteBridge` in `features/pages/threadPages.ts`). Web replies queue through
  `enqueueComposerSend` with `inheritThreadSettings` (patches/durable-client-command-outbox.md). The
  page host gives a refused send back to the page (patches/html-render-bridge.md). Docs:
  `docs/user/thread-sidebar.md` (Triage what needs you) and `docs/user/keybindings.md`.

## Removal

Retire this patch when upstream tracks what agents ask the user as durable state that only acting
ends, detects turns that end waiting on the user, and lists those threads apart from finished ones.
Retire the page index and lists when upstream keeps an index of html renders with seen state; drop
migration 112's table only with a migration that removes it. This patch's notification rules go
when upstream notifies by who started a run and counts what needs the user on every surface. The
web's alerts from shells go once no server built before `needsYou.subscribe` is in use. Retire
triage with the rest; it only reads the Needs you set and the existing reply, answer, snooze and
dismiss paths.

## Verification

- `ThreadAskDecider.test.ts` covers raise, replace, the guard, runs that finish out of order, a
  later run's ask in any status winning, page text and run updates, unsettle and `returnedAt`,
  withdraw, dismiss one and all, trimming, answering, reopening and settle.
- `ThreadAsk.test.ts` covers answering on a user's message (context-only too), a question card
  answer and not an agent's or an empty message, reopening on a cancelled queued reply, a turn-end
  ask landing past a cancelled queued reply or a Codex retry, the guard's reply read starting at
  the run's end, dismiss, settle, auto-settle refusing open asks, and unsettle through the
  orchestrator, with every shell path agreeing.
- `TurnEndAskDetector.test.ts` covers the detector's skip rules (including a run that showed or
  updated a page that asks, but not another run's page ask) and its guarded raise.
- `ThreadSettlementService.test.ts`, client-runtime `threadInbox.test.ts` and
  `threadSnoozed.test.ts` cover settlement, snooze, the inbox and `threadNeedsYou`.
- `evals/thread-asks` measures the detector prompt; `evals/mcp-tool-use` secrets, follow-up and
  question cases check the instruction line.
- client-runtime `threadInbox.test.ts` covers the Needs you order. Web `Sidebar.logic.test.ts`
  covers drop targets and plans with the section (no drops in, none out, no row in the pinned or
  inbox order) and asks reading as Input; `Sidebar.drag.test.ts` covers the section staying in
  place during a drag. Mobile `threadListV2.test.ts` covers the section's members, order and
  exclusion from Pinned, Working, Settled and Snoozed.
- `mcp/toolkits/core.test.ts` covers `ask` raising, updating, truncating and withdrawing page asks,
  refusing an update of a later version's id, and the index writes for each version.
  `HtmlRenderIndex.test.ts` covers list order, paging, the thread filter, seen (per thread, cleared
  by a new version, not on a deleted thread), the asks filter from the thread's open asks, deleted
  threads, indexing a page shown before the index, and which thread changes reach which change
  stream. Web `PagesPage.browser.test.tsx` covers Load more after a new page and a removed one.
  client-runtime `htmlRender.test.ts` covers the in-view rule. `RpcAuthorization.test.ts` and
  client-runtime `commandPermissions.test.ts` cover the RPC scopes. `evals/mcp-tool-use` cases
  `page-collecting-choice-sets-ask` and `control-chart-page-no-ask` check that agents set `ask`
  for a page that collects a choice and not for a chart.
- client-runtime `needsYouTriage.test.ts` covers the deck's members and order under the list's
  filter and snooze rule, staying on a card while others come and go, moving on when the card's
  thread leaves (to the next surviving card before a new one, and when the next card left with it),
  a send clearing only the sent text and one send per thread at a time (while the outbox holds a
  message for the thread, also one restored after a restart and read only once triage opened, and
  a page's send refused meanwhile),
  an interrupted answer keeping its draft without a report, stepping, which cards answer in place (not editor prompts),
  answers built like the thread's question card, and a page mounted from the page index under its
  render id. Web `triageKeys.browser.test.ts` covers the key guards (fields, editors, menus, the
  page's full screen view, modifiers, IME input including keyCode 229, held keys, Esc from the reply
  box, Shift+Esc and a held Esc, Enter chords); `keybindings.test.ts` covers the triage chord per
  client. Mobile `triageDeck.test.ts` covers the deck under a legacy "No project" filter and a
  card's next page starting at its newest version,
  `threadPages.test.ts` a page expanded from a card refused behind the card's queued reply, and
  `android-workspace-navigation.test.ts` Back from a thread opened in triage. Web
  `durableCommandOutboxDelivery.test.ts` covers a triage reply delivered with the thread's settings.
  `HtmlRenderIndex.test.ts` covers the list's lookup by render id.
- Notifications: `NeedsYouNotifications.test.ts` drives the service with committed events over a
  real ledger, across restarts (an ask replacing its run's Done and No reply needed staying
  quiet; a user's run alerting, failing and returning its thread with a wake queued behind it,
  the wake quiet; each delivery checked right before it goes out; a held completion staying
  replaced by its ask after No reply needed; a completion held past the window alerting once a
  watch closes without an event; every pending request alerting on its own, a subagent's approval
  on its parent; a failed delivery not retried once the need ended, also a guest's message sent
  before the service read it while another waits; start retried until the
  cursor is seeded; nothing for the past on a deploy; a restart between recording and sending,
  and one before the cursor moved; reminders after a restart, a snooze and a wake; the digest;
  the count before alerts and never waiting on APNs; archive and unarchive; a failed batch, stream
  or return stamp read again from the cursor; a page ask covering its run's Done; a run that ends
  again under its id; a reopened ask reminding, also when its answer and cancellation, or its
  raise with them, come in one batch; a long snooze reminding past the pruning, and a need that reminded never again; a
  reminder a snooze defers before the service read it; a secret card whose run ended; a hold
  across an outage, also one that ended during it; a failed read of the subjects retried;
  settling ending an ask; versions across pruning), `TurnEndAskDetector.test.ts`
  (reads only after success, retries within the window, also of the ledger's lookup and mark, a
  run another process read, recovery of
  the user's run with a wake queued behind it, also after a failed first read of that list, a later run's question and its own completed
  secret card or a sign-in not covering it, a link card the run left waiting behind a later run's
  approval or linked before the read), `ThreadAsk.test.ts` (`thread.return`, quiet runs
  on settled threads, a late failure on a thread settled after it),
  `ThreadNotificationCoordinator.logic.test.ts` (new subjects by version, the cursor kept before
  waiting subjects, the presentation channel, claims per environment that expire, the stream or the shells
  for an older server, alerts from shells by thread and need), `ThreadNotificationCoordinator.badge.browser.test.ts`
  (the badge, each subject once per browser across reconnects, tabs and reloads, history for a
  first-time browser, the quiet replacement, catching up past a superseded Done, a subject waiting
  for its thread, also across snapshots queued behind another tab's claims, an ask waiting until
  the tab's thread shows it open, a failure on a snoozed
  thread, resolved subjects, also when the resolution, the thread's load and a snapshot without
  the subject queue behind the claims, a waiting subject a snapshot leaves out, archive and
  unarchive, the digest in one tab, a reminder and an alert the browser refused left to a tab
  that can present them, or shown as a toast in a focused one), `LocalAgentAwareness.test.ts`
  (rows never alert, a push token that changed while a Live Activity registered, a refused end sent
  again, one alert per device and what became of it, an alert decided only once it
  holds the lock, coalesced and retried badges, the count without rows),
  `ApnsProvider.test.ts` (payloads, headers, collapse ids, the deadline closing a stalled
  request), `ThreadControl.test.ts` (the watch's waits, also in a parent's detail), shared `agentAwareness.test.ts` (asks
  wait, quiet completions vanish), `ProjectionStore.test.ts` (who started the latest run through
  chains of continuations, also seventeen restarts long, there and in `readRunEnd`, `returnedAt` and `lastSnoozeWakeAt`, in both shell paths),
  client-runtime `threadInbox.test.ts` (inbox time by `returnedAt` and for quiet runs, the count),
  desktop `notificationBadge.test.ts`, mobile `registrationEnvironmentSelection.test.ts` and
  `remoteRegistration.test.ts` (the owner of the device registration, kept across a relaunch and
  read on a cold launch, learned again for a record from before owners, and no icon count while it
  is not known).
- Real clients (web and the iOS app): the Needs you section, No reply needed from the row, menu,
  swipe and ask line, a reply ending an ask, and the ask line, captured on a dev server with real
  turn-end asks from Claude Haiku and a question from Claude's question tool. Page asks arrive with
  `html_render` in a later change; their line, Open and Jump to it were checked with a page ask
  written into a dev database. Notifications were checked on a dev server with real Claude Haiku
  turns and APNs off: a Done and its ask taking its place without a second sound, a quiet
  agent-started run, a server stopped while the detector read a run still giving one ask; and on
  the iOS app, the icon count clearing when the last environment is removed.

## Follow-ups

- APNs: reuse one HTTP/2 session per origin instead of a connection per push. Declined for now;
  the server sends tens of pushes a day.
- The T3 Connect relay path keeps upstream's five-second completion confirmation, which fires
  before the turn-end detector; the relay is off in this fork, and its alerts come from state
  transitions, so they cannot be collapsed. Revisit if the relay is turned on.
- Needs that were open before the first start with the ledger never remind, since no subject
  records them. Declined in review (S50): a one-time edge of the first deploy.
- The web digest follows the server's 19:00 and, with several environments, comes from each
  server with only its own count. A browser-local digest across environments needs a client-side
  merge of their needs. Declined in review (S49).
- A request in a task delegated from another environment alerts from that environment, under the
  task's own thread; the parent in the other environment does not show it.
- On a server built before the needs-you stream, the web's shell fallback keys a subagent's request
  by its parent alone, since the shell carries only the request's kind. A second delegated
  approval under the same parent within two days stays quiet on such a server. Declined in review
  (CodeRabbit 5535): carrying the child request's id into the shell for a rollout-only path.
- The server's `lastBadge` is the last count APNs accepted, not the one the phone shows: APNs can
  reorder pushes or drop an expired badge-only push. The app sets its own count from the server
  whenever it is open, which corrects it. Declined in review (CodeRabbit 5520).
- With sound as the only channel, a tab whose audio the browser has not unlocked yet can claim an
  alert it then cannot play, and a tab that could play it skips it. Declined in review (CodeRabbit
  5499): choosing the channel would need audio readiness and a retry once audio unlocks.
