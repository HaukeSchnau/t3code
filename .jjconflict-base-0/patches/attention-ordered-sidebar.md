# Attention-ordered sidebar

## Requirement

The default sidebar is an inbox. Threads that need the user appear before all other active threads.
Latest user message orders threads inside each group. Working and monitoring remain normally
prominent and keep their recency position. Opening a thread, assistant output, tool activity, and
metadata changes do not affect its position.

Pinned, snoozed, and settled sections retain their existing order. Project pickers derive their
order from the first live thread each project owns in the sidebar, then place projects without live
threads alphabetically.

## Implementation boundary

The shared comparator lives in `packages/client-runtime/src/state/threadSort.ts` so web and mobile
use the same bands and timestamp fallback. Each client derives attention from the state it owns.
Web includes locally acknowledged completions and wakes; mobile currently has no persisted visit
state, so it promotes server-backed approval, input, failure, and plan-ready states.

The legacy sidebar retains its explicit project and thread sort controls. The default sidebar does
not expose a sort preference.

## Verification

- `packages/client-runtime/src/state/threadSort.test.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/mobile/src/features/threads/threadListV2.test.ts`

## Retirement

Retire this patch if upstream adopts the same attention bands, latest-user-message tie-break, and
project-picker alignment across web and mobile.
