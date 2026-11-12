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

- **A nightly gardener.** A home with `T3CODE_FOLLOW_UP_GARDENER_AT` (local `HH:MM`) launches one
  agent thread a night in the scratch project with the server's default model. It merges
  duplicates, closes finished work, checks conditions, keeps types consistent and reads the threads
  its members (`T3CODE_FOLLOW_UP_MEMBERS`) settled since the last pass. Its thread's last message
  is the report, and saves from that thread log as the gardener's. Clients can start a pass at once
  (`followUps.runGardener`).
- **Hints at thread start.** The first turn of a top-level thread a user started (not a scheduled
  task or a goal command) gets one line naming open follow-ups whose title its first 2,000
  characters mostly repeat (two or more title words, at least 60% of them) or whose id it cites.
  It reads the 100 most recently updated open follow-ups. Weak matches stay silent. Turn start sits below the peer link in the layer graph, so the server
  above registers the lookup in `FollowUpHints`; without it, and after two seconds, there is no
  hint. The line goes to the provider only, beside the restart note.

## Upstream touch points

- `apps/server/src/persistence/Migrations.ts` (fork migration 110).
- `packages/contracts/src/rpc.ts` (`ForkWsRpcGroup`) and `server.ts` (`ServerConfig.followUpHome`).
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` (the hint joins the inline
  context of a thread's first turn).
- `apps/server/src/ws.ts` (fork RPC layer and the config field), `server.ts` (layer wiring),
  `mcp/McpHttpServer.ts` (toolkit registration), `provider/agentContextBudget.json`.
- Web: the inbox rows in `Sidebar.tsx`, `Sidebar.logic.ts` and `Sidebar.drag.ts` (a follow-up row
  kind that never drags but holds its place), the sidebar utility menu, `mainAppLocation.ts`, the
  command palette, and `CustomSnoozeDialog.tsx` (optional wording for Later).
- Mobile: a fourth workspace tab across `navigation-tab-order.ts`, `workspace-tabs-state.ts`, the
  root screens, `WorkspaceExtraTab.tsx` and the native tab bars (`T3SidebarTabBarView.swift`,
  `T3WorkspaceNavigationModule.kt`, so a new tab needs a native build); inbox rows in
  `threadListV2.ts`; the `FollowUp` route in `Stack.tsx`.
- `packages/client-runtime/src/state/threadInbox.ts` (`inboxReturnTime`, shared by threads and
  follow-ups in the inbox order).
- Quote to follow-up: `AssistantSelectionToolbar.tsx` on web; on mobile `ThreadFeed.tsx`,
  `EnrichedMarkdownText.tsx` and `SelectableMarkdownText.types.ts` pass a selection menu item to
  the markdown library.
- Phone capture: the `FollowUpCapture` route in `Stack.tsx`, the app shortcuts (iOS now publishes
  "New task" and "New follow-up" quick actions too) and the mobile command palette.

## Removal

Remove when upstream keeps agent-written follow-ups with their origin and shares one store across
linked environments. Migration 110 must stay in the registry.
