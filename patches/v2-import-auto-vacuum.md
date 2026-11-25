# V2 import of an auto-vacuum source

## Why

Upstream's #30066 copies the V1 `state.sqlite` to `statev2.sqlite` with `VACUUM INTO` and first runs
`PRAGMA auto_vacuum = INCREMENTAL` on its read-only connection. When the source already sets an
auto_vacuum mode, that pragma rewrites the header, and SQLite refuses it with "attempt to write a
readonly database". New databases get incremental auto_vacuum and WAL from `persistence/Sqlite.ts`,
and the fork's CLI creates `state.sqlite` through `layerConfigAttached`. So a server that starts
with such a V1 file and no V2 database cannot import it, and `t3 settings` failed the same way.

## Behavior

The snapshot worker in `apps/server/src/persistence/initializeV2Database.ts` sets the pragma only
when the source reads `auto_vacuum = 0`. A source with incremental or full mode keeps that mode in
the copy, and both return freed pages.

## Removal

Drop this once upstream guards the pragma the same way, or its copy otherwise tolerates sources
that already use auto_vacuum.

## Verification

`initializeV2Database.test.ts`: "copies a WAL source whose auto_vacuum is already …" for both
modes, and `cli/settings.test.ts`.
