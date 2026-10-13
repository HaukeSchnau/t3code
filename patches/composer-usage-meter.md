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
- A provider that cannot report its own windows, such as Claude sending through a CLIProxyAPI hub
  with the hub's API key, shows the pooled share left of the hub's accounts for its driver: the
  numbers Usage → Limits leads with. Hovering lists each pooled window with the next reset that
  hands quota back.
- Nothing shows when the provider reports no windows or a failed probe, or cannot report and no hub
  has accounts for its driver. The meter also hides in the resting and compact composer layouts and
  next to wide pending actions.
- Web and desktop only. Mobile keeps upstream's `/usage-limits` and Usage → Limits.

## Implementation

`apps/web/src/components/chat/ComposerUsageMeter.tsx` and its `.logic.ts` are fork-owned.
`ChatComposer.tsx` passes `selectedProviderStatus` and the environment's `usageLimitSources` to
`ComposerFooterPrimaryActions`, which renders the meter before the context ring.

## Removal

Drop this patch if upstream adds an always-visible limits indicator to the composer.
