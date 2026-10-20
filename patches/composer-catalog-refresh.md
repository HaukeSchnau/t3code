# Composer catalog refresh

## Requirement

The composer's `$` skill picker and `/` command menu must show skills and commands that were added
or removed since the project's workspace catalog was read. A provider snapshot carries a
machine-wide catalog and per-project `workspaceSnapshots`. The composer reads the workspace
catalog for its project whenever one exists.

## Why upstream does not meet it

`mergeProviderSnapshot` in `apps/server/src/provider/ProviderRegistry.ts` keeps the previous
`workspaceSnapshots` whenever a refresh has none of its own, which a machine-wide status probe
never has. A skill installed or removed after the workspace catalog was read stays wrong in the
composer until that project's catalog is read again.

## Design

When a refresh changes the machine's skills or slash commands, the merge drops the previous
workspace snapshots. The next composer read loads the project's catalog again. A refresh that only
changes metadata, such as `checkedAt`, keeps them. OpenCode's retained skills and commands for a
refresh that reported none count as unchanged.

## Removal

Remove this when upstream invalidates workspace catalogs on machine catalog changes, or reads
workspace catalogs without caching them across machine refreshes.

## Verification

`ProviderRegistry.test.ts`: "invalidates workspace catalogs when machine skills or commands
change".
