# Sidebar Organization

## Goal

Add local UI organization tools for a personal fork: an All Threads sidebar lens, pinned threads,
and lightweight tags for projects and threads.

## Source Context

- Backfilled from the current fork delta against `main@upstream`.
- Session archive thread `019e9250-2f9a-7eb2-ae2d-bba2d915ffc3` established the product model:
  sidebar modes are alternate lenses, thread project identity stays fixed, All Threads is global
  chronological with pinned threads first, and tags are local UI metadata rather than provider or
  project identity.
- The same session later refined Tags view into collapsible tag groups where multiple groups can be
  open, project tags are inherited dynamically, and threads may appear under multiple matching tags.

## Requirements

- Keep the existing Projects view as the default sidebar mode.
- Add `All Threads` as a flat chronological lens over threads.
- In All Threads, show pinned threads first, then recent unpinned threads by last activity.
- Show project identity clearly on every All Threads row.
- Treat thread project identity as fixed. Do not implement "move thread" by mutating a thread's
  project; a future move workflow should be a fork/recreate operation if it exists at all.
- Store pins and tags as local persisted UI state, not provider/session metadata.
- Keep pinned threads visible when their project row is collapsed.
- Add tag state with:
  - global tag catalog
  - thread tag ids by thread key
  - project tag ids by project key
  - expanded/collapsed tag group state
- Normalize tag names by trimming and collapsing whitespace.
- Derive tag ids from lower-cased normalized names.
- Assign deterministic tag colors and sanitize persisted tag colors.
- Project tags are inherited dynamically by threads in that project; do not copy inherited tags into
  each thread.
- A thread can have multiple tags and can appear under multiple expanded tag groups.
- Tags view uses top-level collapsible tag groups.
- Inside each expanded tag group, show pinned matching threads first and then recent matching
  threads by last activity.
- Do not show tag chips inside Tags view thread rows when the surrounding group already provides
  tag context.
- Persist sidebar mode, pins, tag catalog, tag assignments, tag expansion, project order, and
  project expansion state.
- Prune stale tag references when threads or projects disappear.
- Preserve legacy project expansion/order localStorage semantics during migration.

## Upstream Touch Points

- `apps/web/src/uiStateStore.ts`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/ChatHeader.tsx`
- `apps/web/src/tagColors.ts`
- `apps/web/src/components/TagColorDot.tsx`

## Non-Goals

- Do not add provider/server-side tags.
- Do not sync tags across devices.
- Do not make tags hierarchical or scoped per project.
- Do not add per-thread overrides to hide inherited project tags in the MVP.
- Do not replace Projects view with All Threads or Tags.

## Verification

- `apps/web/src/uiStateStore.test.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/web/src/components/ChatView.browser.tsx`
- Required repo gates: `vp check` and `vp run typecheck`.
