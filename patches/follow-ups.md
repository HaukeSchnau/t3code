# Follow-ups

## Fork requirement

Threads often end with work worth doing later. Agents write it down as a follow-up that knows the
thread and message it came from, so whoever picks it up later has the full context. The user sees
follow-ups in the app, they come back to the inbox on their date, and picking one up starts a
thread that links back. Upstream has scheduled tasks, which wake a thread at a time, but nothing
that keeps a tidy list of open work with its origin.

## Behavior

- **One store per space.** An environment keeps its own follow-ups unless `T3CODE_FOLLOW_UP_HOME`
  names another environment (the maintainer's `~/infra` sets it per host from `lib/managed-hosts.nix`:
  the personal machines name srv-2, dev-hauke keeps its own). The server advertises the home as
  `ServerConfig.followUpHome`, its own id when it keeps its own. Clients show the stores of the
  homes their switched-on environments name, so an environment mode that switches between personal
  and work machines switches stores too.
- **Two agent tools.** `follow_ups` searches and reads, `follow_up_save` writes, defines types,
  closes and merges. Every tool description lands in every agent's context, so the feature stays at
  two tools. On an environment whose home is elsewhere, both tools forward to the home over the
  existing peer link (`PeerForwarding.call`), so each personal machine needs a link to the home and
  Linked environments switched on.
- **Origin is T3's.** A save records the calling thread and the user message that started its turn.
  The home sees a forwarded call as the link, not as a thread, so the forwarding environment sends
  its caller as `fromThread`, completed with its own environment id. Agents use the same field when
  a follow-up came from another thread they read. The home takes a thread on another environment
  as given and checks only its own threads, so anyone who may save there can name any origin; the
  maintainer's links are full access, and fenced links can save too (`linkedCallers: "allowed"`).
- **Types keep the vocabulary.** Fields belong to a type from the registry; saving an unknown type,
  a field the type lacks, or fields without a type fails with the names that exist. A type cannot
  drop a field that follow-ups still use.
- **Every change is logged** in `follow_up_changes` with its actor, so the nightly gardener's edits
  stay visible and reversible.
- **Dates return follow-ups to the inbox.** The server's scheduler sets `returnedAt` when `dueAt`
  passes; moving the date clears it. Clients merge returned follow-ups into the inbox section of
  the thread list. `dueAt` is stored as UTC ISO text so the scan compares strings.

- **Links, not ids.** Both tools return each follow-up's `link`, `t3-follow-up://<home>/<id>`
  with its title as the label, and their descriptions tell agents to name follow-ups by it. A
  forwarding environment rebuilds the links of the home's answer, so they name the home whatever
  the home sent. Outside MCP clients get no link: no hosted page opens a follow-up, unlike the
  hosted thread links they get. Clients render the links as chips with the current title and
  status, read from the home's open list, and its closed list only when the open one lacks the
  link. A link whose home isn't connected, or whose follow-up is gone, stays a plain link with the
  agent's label. Web opens `/follow-ups?home=<home>&id=<id>`, mobile the `FollowUp` route.
- **A nightly gardener.** The maintainer's `~/infra` declares it on each home as a scheduled task
  (`patches/declared-scheduled-tasks.md`), with a prompt that names the home's members, so T3 has
  no gardener of its own. Settings runs it at once. Saves from its thread log as an agent's; the
  `gardener` actor kind stays for changes the built-in gardener logged, and migration 110 still
  creates `follow_up_gardener_runs`, which nothing reads anymore. The snapshot still sends
  `lastGardenerRun: null` because older clients require the key; drop it once every client has
  updated past the release that removed the built-in gardener.
- **Hints at thread start.** The first turn of a top-level thread a user started (not a scheduled
  task or a goal command) gets one line naming open follow-ups whose title its first 2,000
  characters mostly repeat (two or more title words, at least 60% of them) or whose id it cites.
  It reads the 100 most recently updated open follow-ups. Weak matches stay silent. Turn start sits below the peer link in the layer graph, so the server
  above registers the lookup in `FollowUpHints`; without it, and after two seconds, there is no
  hint. The line goes to the provider only, beside the restart note.
- **Loose ends at settle.** One line in the agent instructions says that an agent asked whether a
  thread is done or can be settled saves each remaining loose end with `follow_up_save`, searching
  first. It names that question on purpose: a broader wording sent agents on follow-up detours
  during ordinary work. Upstream adds its own settle line ("Asked to settle a thread, this one too:
  `t3_thread_organize`", #26765). At the sync, merge the two into one line that covers "settle
  this thread" too, so a settle request saves loose ends before it organizes the thread.

## Upstream touch points

- `apps/server/src/persistence/Migrations.ts` (fork migration 110).
- `packages/contracts/src/rpc.ts` (`ForkWsRpcGroup`) and `server.ts` (`ServerConfig.followUpHome`).
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` (the hint joins the inline
  context of a thread's first turn).
- `apps/server/src/ws.ts` (fork RPC layer and the config field), `server.ts` (layer wiring),
  `mcp/McpHttpServer.ts` (toolkit registration), `provider/agentContextBudget.json`.
- `packages/provider-core/src/server/orchestrationInstructions.ts` (the loose-ends line).
- Web: the inbox rows in `Sidebar.tsx`, `Sidebar.logic.ts` and `Sidebar.drag.ts` (a follow-up row
  kind that never drags but holds its place), the sidebar utility menu, `mainAppLocation.ts`, the
  command palette, and `CustomSnoozeDialog.tsx` (optional wording for Later). The fork's own
  components borrow upstream's design system pieces: the Follow-ups page rows use the pull request
  page's row (`PullRequestRowLines`, `PULL_REQUEST_ROW_CLASS` and the `PAGE_ROW_*` classes), and the
  inbox row is a `SidebarMenuButton`, so a sync that renames those breaks only fork files.
- Links: `packages/shared/src/markdownHast.ts` (the scheme passes sanitizing),
  `mcp/McpInvocationContext.ts`, the web `ChatMarkdown.tsx` anchor and `ContextChip.tsx` (a
  `follow-up` kind and accent), and on mobile `ThreadFeed.tsx`, `enrichedLinkPresentation.ts`,
  `useEnrichedLinkVariants.ts` and a `list-todo` chip icon.
- Mobile: a Follow-ups workspace tab after upstream's shared Pull requests and Issues slot, so the
  bar holds four tabs and Settings, across `navigation-tab-order.ts`, `workspace-tabs-state.ts`
  (a one-page tab, like Usage and Workflows), the root screens, `WorkspaceExtraTab.tsx` and the
  native tab bars (`T3SidebarTabBarView.swift`,
  `T3WorkspaceNavigationModule.kt`, so a new tab needs a native build); inbox rows in
  `threadListV2.ts`; the `FollowUp` route in `Stack.tsx`.
- `packages/client-runtime/src/state/threadInbox.ts` (`inboxReturnTime`, shared by threads and
  follow-ups in the inbox order).
- Quote to follow-up: on web `followUps/QuoteFollowUpAction.tsx`, which
  `AssistantSelectionToolbar.tsx` mounts beside Copy; on mobile `ThreadFeed.tsx`,
  `EnrichedMarkdownText.tsx` and `SelectableMarkdownText.types.ts` pass a selection menu item to
  the markdown library.
- Phone capture: the `FollowUpCapture` route in `Stack.tsx`, the app shortcuts (iOS now publishes
  "New task" and "New follow-up" quick actions too) and the mobile command palette.

## Removal

Remove when upstream keeps agent-written follow-ups with their origin and shares one store across
linked environments. Migration 110 must stay in the registry.
