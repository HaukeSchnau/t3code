# Composer usage meter

## Why this patch exists

Upstream shows subscription limits on request (the `/usage-limits` composer banner and Usage →
Limits) and in an opt-in **Usage limits** row of the thread details card, which shows only when the
card is open and has no pooled CLIProxyAPI fallback. Hauke wants them visible while writing, as the
fork's old composer meter was. That
meter and its forecast model were removed in favor of upstream's data (fork PR #52). This rebuild
keeps the visible meter and reads only upstream's provider snapshots.

## Requirements

- The composer footer shows the selected provider's session and weekly windows as small bars with
  the quota left. Providers with other windows fill the two rows in their
  reported order.
- A bar turns amber when spending runs ahead of the window (upstream's `paceOf`) and red with 10% or
  less left. Hovering opens upstream's `LimitWindows` for every window, with reset times.
- A provider that cannot report its own windows, such as Claude sending through a CLIProxyAPI hub
  with the hub's API key, shows the pooled share left of the hub's accounts for its driver: the
  numbers Usage → Limits leads with. Hovering lists each pooled window with the next reset that
  hands quota back.
- Nothing shows when the provider reports no windows or a failed probe, or cannot report and no hub
  has accounts for its driver. The meter also hides when the composer footer is compact
  (narrower than 620 px) and next to wide pending actions.
- Web and desktop only. Mobile keeps upstream's `/usage-limits` and Usage → Limits.

## Implementation

`apps/web/src/components/chat/ComposerUsageMeter.tsx` and its `.logic.ts` are fork-owned.
`ChatView.tsx` passes the environment's `usageLimitSources` to `ChatComposer.tsx`, which passes
them with `selectedProviderStatus` to `ComposerFooterPrimaryActions` in
`chat/ComposerFooterControls.tsx`, which renders the meter before the primary actions.
`ChatComposer.tsx` keeps an `isComposerFooterCompact` state beside upstream's
`isComposerPrimaryActionsCompact` for the hide rule. The pooled fallback hands `collectLimitAccounts` from `packages/shared/src/usageLimits.ts`
a presentation with no providers, so only the hub accounts count.

## Removal

Drop this patch if upstream adds an always-visible limits indicator to the composer.
