# Sidebar drag with orchestration trees

## Requirement

The default web sidebar keeps upstream's full-list drag (move between Pinned, Active, Snoozed and
Settled, reorder Pinned and Active) while it renders pinned and active threads as orchestration
trees (`docs/internals/thread-orchestration-sidebar.md`), full cards on every shelf, attention bands
(`patches/attention-ordered-sidebar.md`) and workspace groups in project-scoped lists
(`patches/workspaces.md`). Upstream's drag assumes a flat list of single rows, slim shelf rows and
key order equal to display order.

## Changes to upstream-owned drag code

- `Sidebar.tsx`: every sortable thread renders through `SortableThreadBlock` instead of upstream's
  `SortableThreadRow`. A block is a top-level thread with its visible subtree. The wrapper is the
  droppable node that peers measure and the element that translates; the root row is the draggable
  node and alone carries the pointer listeners. dnd-kit therefore restricts, collides and
  auto-scrolls with the root card, so a tall expanded tree still follows the pointer. Shelf rows are
  single-row blocks, so a row keeps its DOM node, and glides, when it changes section. Over another
  section a lifted tree shows only its root, because pin, unpin and settle move only that thread;
  nested rows turn invisible without changing layout, matching upstream's rule that previews never
  move or mount DOM nodes.
- `Sidebar.logic.ts`: `planSidebarBlockDrop` wraps upstream's `planSidebarThreadDrop`. It leaves
  rows that will nest once the drop lands out of the order, only offers active slots inside the moved
  thread's attention band and plans keys there, and writes no position while
  `isSidebarActiveOrderLocked`.
  `buildSidebarBlocks` derives the blocks and workspace groups. `SidebarListMarker` gains
  `workspace-header:<key>` markers, which the sorting strategy hides during a drag.
- `Sidebar.drag.ts`: `measuredRows` keeps a moved row's measured height instead of upstream's
  card/slim heights, and `crossSectionHeight` sizes a tree that previews only its root.
- `Sidebar.tsx` keeps upstream's drop hold unchanged. The planner returns the root order the hold
  waits for, or null when only the section changes.

Known gap: `createSidebarListMotion` animates the list's direct children, which are whole blocks.
Blocks glide as units, but a nested row that appears, finishes or changes group inside a tree pops in
place instead of fading. Animating nested rows would need a motion per tree.

## Verification

- `apps/web/src/components/Sidebar.logic.test.ts` (`buildSidebarBlocks`, `planSidebarBlockDrop`)
- `apps/web/src/components/Sidebar.drag.test.ts` (fork block rows)

## Retirement

Retire this patch if upstream sidebar trees, shelf cards and grouped lists are dropped from the
fork, or if upstream's drag gains nested rows and a display order that differs from key order.
