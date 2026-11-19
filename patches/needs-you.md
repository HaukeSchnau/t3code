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
  and a `page` ask when a page asks its reader for input (raised by `html_render`, a later change).
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
  pending request or card, runs without a final message, and runs the user already answered.
  Failures are logged and skipped.
- T3's agent instructions tell agents to ask decisions with their question tool instead of ending
  a turn on a question in prose.
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
- `apps/server/src/server.ts`: starts the detector next to the title refresh.
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

## Verification

- `ThreadAskDecider.test.ts` covers raise, replace, the guard, runs that finish out of order, a
  later run's ask in any status winning, page text updates, unsettle, withdraw, dismiss one and
  all, remind, trimming, answering, reopening and settle.
- `ThreadAsk.test.ts` covers answering on a user's message (context-only too), a question card
  answer and not an agent's or an empty message, reopening on a cancelled queued reply, a turn-end
  ask landing past a cancelled queued reply or a Codex retry, the guard's reply read starting at
  the run's end, dismiss, settle, auto-settle refusing open asks, and unsettle through the
  orchestrator, with every shell path agreeing.
- `TurnEndAskDetector.test.ts` covers the detector's skip rules and its guarded raise.
- `ThreadSettlementService.test.ts`, client-runtime `threadInbox.test.ts` and
  `threadSnoozed.test.ts` cover settlement, snooze, the inbox and `threadNeedsYou`.
- `evals/thread-asks` measures the detector prompt; `evals/mcp-tool-use` secrets and follow-up
  cases checked the instruction line.
- client-runtime `threadInbox.test.ts` covers the Needs you order. Web `Sidebar.logic.test.ts`
  covers drop targets and plans with the section (no drops in, none out, no row in the pinned or
  inbox order) and asks reading as Input; `Sidebar.drag.test.ts` covers the section staying in
  place during a drag. Mobile `threadListV2.test.ts` covers the section's members, order and
  exclusion from Pinned, Working, Settled and Snoozed.
- Real clients (web and the iOS app): the Needs you section, No reply needed from the row, menu,
  swipe and ask line, a reply ending an ask, and the ask line, captured on a dev server with real
  turn-end asks from Claude Haiku and a question from Claude's question tool. Page asks arrive with
  `html_render` in a later change; their line, Open and Jump to it were checked with a page ask
  written into a dev database.
