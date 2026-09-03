# Persistent diff worker pool

## Purpose

Keep the `@pierre/diffs` worker pool alive across thread and draft route changes. `ChatView` is keyed and
remounted as chat selection changes; owning the pool there created a fresh set of workers on every switch and
left the browser retaining the old worker scripts and related component state until garbage collection.

## Behavior

The persistent `/_chat` route layout owns exactly one `DiffWorkerPoolProvider` around its child `Outlet`.
Individual `ChatView` instances consume that route-owned pool and no longer create their own provider. The pool
still unmounts when leaving the authenticated chat area entirely.

## Requirements

- Switching threads, projects, drafts, or chat child routes must reuse the same worker pool.
- All chat content rendered through the `/_chat` outlet must remain inside the provider.
- Leaving the `/_chat` route may terminate the workers normally.
- A route-structure regression test must keep the provider above the child outlet.

## Maintenance risk

This patch touches upstream route/component ownership but not diff rendering behavior. During upstream syncs,
prefer an upstream persistent provider if one exists; otherwise preserve the route-level lifetime and the
structure test.
