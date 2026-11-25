# Redesign integration bookmark

## What it is

`redesign` is a bookmark on origin that runs Maria's in-progress redesign of the web UI with every
fork feature. The redesign is a stack of six open upstream pull requests (pingdotgg/t3code
#28839 to #28845, branches `maria/redesign/1-primitives-shell` to `maria/redesign/6-workspace-panes`).
Layer 6 replaces the right panel with split workspace panes whose tabs hold chats, files,
terminals, pull requests and the browser.

The stack is force-pushed often, so its commits never enter fork `main`. The bookmark is rebuilt
instead. Production deploys it (`defaultBranch` in `.calder/ci.ts` and infra's
`hosts/srv-2/calder.nix`), and fork work lands on it first, then gets backported to `main`
(AGENTS.md "Fork maintenance"). Forgejo's default branch is `redesign`, so fresh clones start
there. A clone made before that switch keeps `main` until it runs
`git remote set-head origin redesign` and `jj config set --repo 'revset-aliases."trunk()"' redesign@origin`;
T3's jj stack view and the base of the pull requests it opens follow `trunk()`.

## Shape

From the bottom:

1. **The merge** (`merge: run Maria's redesign stack ...`): fork `main` and the head of layer 6,
   with conflict resolutions only. Keeping it to resolutions lets jj carry them through a rebase.
2. **The reconcile commit** (`fix(web): reconcile fork main with the redesign stack`): fixes that
   are not conflict resolutions. Upstream main is ahead of the stack's base, so it may delete
   helpers the stack still uses or change tests the stack no longer fits; fork code moves to
   renamed redesign APIs.
3. **One port commit per fork feature**, which moves that feature's UI onto the redesign.
4. **The catalog commit**, the output of `gt generate` in `apps/web`.
5. **Fork work merged into `redesign`**, one squashed commit per pull request. A refresh drops each
   one whose backport `main` already has. What only fits the redesigned UI stays and is listed
   under [Redesign-only work](#redesign-only-work).

Resolution rules on top of [Fork workflow](fork-workflow.md): the redesign's structure, markup and
styling win; upstream main changes the stack lacks are carried into the redesign's code; fork
behavior that a patch doc describes survives. Fork UI lives in fork-owned components mounted from
upstream components with one-line insertions, so the next upstream rewrite costs a few one-line
conflicts. Fork UI follows the redesign's design-system lint (type roles, `surface-*` utilities,
`components/ui` variants). Fork files never go into `lint-ceilings.json`.

## Refreshing

1. Fetch: `jj git fetch --remote origin`, then
   `git fetch upstream 'refs/heads/maria/redesign/*:refs/remotes/upstream/maria/redesign/*'`.
   Note the commit `redesign@origin` points at: the refresh rebuilds that head.
2. Rebase the merge onto both new heads:
   `jj rebase -s <merge> -d main@origin -d maria/redesign/6-workspace-panes@upstream --skip-emptied --ignore-immutable`
   with `--config ui.conflict-marker-style=git`. Find the merge with
   `jj log -r 'description(glob:"merge: run Maria*") & ::redesign@origin'`. `trunk()` is
   `redesign@origin`, so jj treats the whole bookmark as immutable; commands that rewrite it while
   resolving need `--ignore-immutable` too. jj carries the earlier resolutions, so only new
   collisions need work.
3. Resolve new conflicts in the merge first (resolutions only), then in the commits above it.
   When manifests changed, run `pnpm run fork:lockfile` and fold the lockfiles into the merge.
   `--skip-emptied` drops a layer commit only when its replay is empty, as an exact backport
   leaves it. Read the layer (`jj log -r '<merge>::redesign'`) and abandon commits that `main`
   now has in adapted form.
4. Catalog conflicts are derived output: take either side, rerun `gt generate` in `apps/web`, and
   fold the result into the catalog commit. New fork strings carry their English text in every
   locale.
5. Prove it the way a sync does (typecheck, `vp run check:changed`, the web suites, a dev server
   pass on seeded data). Tag the head you rebuilt
   (`git push origin <commit>:refs/tags/redesign-prev/<short commit>`), because redesign-only work
   exists nowhere else. Then move the bookmark and push it. `jj git push` refuses when origin moved
   since the fetch: then fetch, rebase every commit that landed after the rebuilt head onto the
   refreshed one, rerun the proof, and tag and push again.

An open pull request into `redesign` rebases only its own commits after a refresh:
`jj rebase -s <its first commit> -o redesign@origin`. T3's rebase-onto-trunk action would carry the
old merge and Maria's old stack along with them.

The upstream-sync skill refreshes the bookmark weekly, whenever it lacks `main@origin` or Maria's
current head.

## Where fork features sit in the redesign

- Artifact previews: an `artifact` surface tab rendered by `ThreadSurfaceTab.tsx`, titled in
  `layout/surfaceTabLabels.ts`, iconized in `SurfaceTabIcon.tsx`, dragged in `layout/layoutDrag.ts`.
- Thread-details hub limits: `chat/ThreadDetailsHubLimits.tsx`, mounted in `ThreadDetailsUsage.tsx`.
- Workspaces and worlds: `ManagedWorkspaceSelector` and `JjStackControl` in `BranchToolbar.tsx`
  and the details Workspace card; `ThreadWorldPanel` in `ThreadDetailsPanel.tsx`.
- jj commit trailers: `settings/JjCommitTrailerSettings.tsx`, after the merge method row.
- Follow-ups and Pages: still `/follow-ups` and `/pages` route pages, reached from the sidebar
  footer's icon row. Quoting a selection into a follow-up and inline replies are buttons in the
  redesigned selection toolbar (`followUps/QuoteFollowUpAction.tsx`,
  `InlineSelectionReplyButton` in `chat/AssistantInlineReplies.tsx`).
- Needs you: the sidebar shelf, the triage modal (`needsYou/TriagePage.tsx`) in the `app-panel`
  frame.
- Codex: the overload retry line in the redesign's error notice (`chat/ThreadErrorDetail.tsx`);
  optional questions in the request card (`chat/OptionalQuestionControls.tsx`); Pause in
  `StopGenerationSlot`.
- Durable outbox and peer sign-in: delivery and fan-out mount in `AppSidebarLayout.tsx`, because
  the redesign's workspace plane unmounts the chat layout's outlet while a thread is open. The
  outbox entries and network status are redesign tray notices.
- OIDC sign-in: `auth/OidcSignInButton.tsx` in the pairing page's button row.
- Fleet placement: `ThreadPlacementChip` follows the thread tab strip in `chat/ChatHeader.tsx`,
  and a thread waiting for room is a composer banner (`chat/placementWaitBanner.tsx`).

## Redesign-only work

Fork work merged into `redesign` with no backport in `main`, because it only fits the redesigned
UI. Each entry names its commit subject and why it can't go to `main`.

None yet.

## Known gaps

- Follow-ups and Pages open as full route pages, not workspace page tabs like pull requests,
  issues and workflows. A tab needs a page kind in `layout/layoutModel.ts` plus entries in
  `pageNavigation.tsx`, `PageSurface.tsx`, `NewTabLauncher.tsx`, `PaneTabs.tsx` and
  `layoutDrag.ts`, which is too much upstream surface for a rebuilt bookmark.
- Inline replies have no selection toolbar in background timelines, so a selection there can't
  be replied to.
- Upstream main's find-shortcut and condensed-search tests for `PullRequestsColumn` went with the
  column; its find fix lives in `workItem/WorkItemListColumn.tsx` without a test.

## Removal

When upstream lands the stack (#28845 last), the next upstream sync merges it into `main`. Rebase
the merge onto `main@origin` and upstream main for that sync, so its resolutions become the
sync's, and send the reconcile, port, catalog and redesign-only commits as a normal fork pull
request. Then point production and new work back at `main`: `defaultBranch` in `.calder/ci.ts`
and infra, Forgejo's default branch, each clone's `origin/HEAD` and `trunk()`, and AGENTS.md
"Fork maintenance". Delete the `redesign` bookmark and this document last.
