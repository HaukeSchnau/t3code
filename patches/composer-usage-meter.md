# Composer usage meter

## Why this patch exists

Upstream shows subscription limits only on request: the `/usage-limits` composer banner and
Usage → Limits. Hauke wants them visible while writing, as the fork's old composer meter was. That
meter and its forecast model were removed in favor of upstream's data (fork PR #52). This rebuild
keeps the visible meter and reads only upstream's provider snapshots.

## Requirements

- The composer footer shows the selected provider's session and weekly windows as small bars with
  the quota left, beside the context ring. Providers with other windows fill the two rows in their
  reported order.
- A bar turns amber when spending runs ahead of the window (upstream's `paceOf`) and red with 10% or
  less left. Hovering opens upstream's `LimitWindows` for every window, with reset times.
- Nothing shows when the provider reports no windows, an unsupported account, or a failed probe. The
  meter also hides in the resting and compact composer layouts and next to wide pending actions.
- Web and desktop only. Mobile keeps upstream's `/usage-limits` and Usage → Limits.

## Implementation

`apps/web/src/components/chat/ComposerUsageMeter.tsx` and its `.logic.ts` are fork-owned.
`ChatComposer.tsx` passes `selectedProviderStatus` to `ComposerFooterPrimaryActions`, which renders
the meter before the context ring.

## Removal

Drop this patch if upstream adds an always-visible limits indicator to the composer.
