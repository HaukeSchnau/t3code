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
  at once. It skips subagent and delegated threads, runs whose stop was requested, threads with a
  pending request or card, runs without a final message, runs that set or updated a page's ask
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

## Implementation

Fork-owned files:

- `packages/contracts/src/threadAsks.ts`: the ask entry, its source and status, the 120-character
  ask text, and the shell's open-ask summary.
- `apps/server/src/orchestration-v2/ThreadAskDecider.ts`: raise, replace, guard, withdraw,
  dismiss, remind, answer on reply, reopen on a cancelled reply, dismiss on settle. Pure, like
  `GuestShareDecider.ts`. Keeps every open ask and the newest resolved ones, 20 in all.
- `apps/server/src/orchestration-v2/TurnEndAskDetector.ts`: the reactor on completed runs.
- `apps/server/src/orchestration-v2/userTurn.ts`: `isUserTurn`, shared by the title refresh and
  asks, and `isUserReply`, a user turn with text, an attachment or context.
- `evals/thread-asks/`: the detector eval.
- `apps/web/src/state/htmlRenderOpenRequest.ts`: lets the ask line open a page's full-screen
  dialog, which the page's frame owns with the bridge the page answers through.
- Tests: `ThreadAskDecider.test.ts`, `ThreadAsk.test.ts`, `TurnEndAskDetector.test.ts`.
- `packages/contracts/src/htmlRenderPages.ts`: the page row, list input and result, seen input,
  change tick.
- `apps/server/src/htmlRender/HtmlRenderIndex.ts`: the index (record, index an older page, seen,
  list, change stream) and the reactor that passes on thread events lists show; migration 112
  (`persistence/Migrations/112_HtmlRenders.ts`); `HtmlRenderIndex.test.ts`.
- Web: `components/chat/ThreadPagesControl.tsx`, `components/chat/HtmlRenderPageDialog.tsx`,
  `components/pages/` (`PagesPage.tsx`, `PageListRow.tsx`), `routes/_chat.pages.tsx`.
- Mobile: `features/pages/` (the Pages screen, the thread's Pages sheet, the page row, the
  thread pages query and route, the seen hooks, and `pagePresentation.ts`).

Upstream-owned hooks:

- `packages/contracts/src/orchestrationV2.ts`: `asks` on `OrchestrationV2AppThread`, stored in the
  thread's `payload_json` with no migration; `openAsks` on the thread shell, present only when
  there are some; `pendingGuestMessageAt` on the shell, so a guest's message sorts by when it
  waits; `card` on the pending request summary so clients can tell a secret or link card
  from a question; client command `thread.ask.dismiss`; internal commands `thread.ask.raise`,
  `thread.ask.withdraw`, `thread.ask.remind`; event `thread.asks-updated`, carrying the thread like
  `thread.guest-share-updated`. `baseSchemas.ts` adds `ThreadAskId`.
- `apps/server/src/orchestration-v2/Orchestrator.ts`: dispatches the ask commands, answers open
  asks in `dispatchMessage` in the same commit as the message, so every user-authored message
  answers them (sends, guest sends, an answer to a question card the agent did not wait on),
  reopens them in `queued-run.cancel`, dismisses them in `thread.settle`, refuses
  `thread.auto-settle` while asks are open, and accepts ask commands that change nothing.
- `apps/server/src/orchestration-v2/ProjectionStore.ts`: the event in the projection switches and
  the updatedAt list, `openAsks` and `pendingGuestMessageAt` in both shell paths, `openAsks` in
  settlement candidates, `card` on secret and link cards, and `getLatestUserReply` (the newest
  `isUserReply` message in SQL, without cancelled queued sends), which the guard and the detector
  read instead of every run and message of the thread. Under the command lock the guard reads
  only messages after the run ended.
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts`: open asks block auto-settle; a
  newer ask ends a snooze.
- `AgentAwarenessRelay.ts`, `GuestShareService.ts`, `testkit/OrchestratorScenario.ts`, client-runtime
  `orchestrationV2Projection.ts`: the new event and command in their switches.
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
- Docs: `docs/user/thread-sidebar.md` (See what needs you) and `docs/user/text-generation.md`.

## Removal

Retire this patch when upstream tracks what agents ask the user as durable state that only acting
ends, detects turns that end waiting on the user, and lists those threads apart from finished ones.
Retire the page index and lists when upstream keeps an index of html renders with seen state; drop
migration 112's table only with a migration that removes it.

## Verification

- `ThreadAskDecider.test.ts` covers raise, replace, the guard, runs that finish out of order, a
  later run's ask in any status winning, page text and run updates, unsettle, withdraw, dismiss
  one and all, remind, trimming, answering, reopening and settle.
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
- Real clients (web and the iOS app): the Needs you section, No reply needed from the row, menu,
  swipe and ask line, a reply ending an ask, and the ask line, captured on a dev server with real
  turn-end asks from Claude Haiku and a question from Claude's question tool. Page asks arrive with
  `html_render` in a later change; their line, Open and Jump to it were checked with a page ask
  written into a dev database.
