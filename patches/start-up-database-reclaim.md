# Start-up database reclaim

## Why

Freed pages only leave the database file when SQLite's auto_vacuum is incremental, and
`persistence/Sqlite.ts` sets that only on new databases. An older database needs one VACUUM, which
needs the file to itself. Settings' Reclaim runs it at server exit and `t3 doctor` runs it by hand.
The fleet service stops with `TimeoutStopSec = 30s`, far less than a VACUUM of a multi-GB database
takes, and nobody runs `t3 doctor` on every host. In November 2026 dev-hauke's 20.7 GiB database
had auto_vacuum off and 10.1 GiB of free pages.

Upstream has no way to VACUUM a server that nobody restarts from Settings.

## Behavior

`storageCleanup.reclaimDatabaseOnStart` is false by default and has no Settings row. Reclaim
already covers desktop and supervised servers, and a start that silently takes minutes would
surprise a desktop user. When it is on, `cli/server.ts` takes the server ownership lock, as
`t3 doctor` does for its repairs, and calls `DatabaseMaintenance.runStartReclaim` before the server
opens its database. Another server or doctor therefore never repairs alongside it. That runs
`DatabaseMaintenance.compact` when:

- the database does not use incremental auto_vacuum,
- at least 1 GiB of it is free pages,
- no `reclaim-failed` file is left from an earlier attempt (one it cannot read counts), and
- `reclaimSpaceShortfall` finds room for the copies.

It writes `reclaim-failed` once `compact` holds the database exclusively and removes it on
success, so an attempt refused as in use never touches the marker of a repair that holds the file.
A failed or killed attempt is not repeated at every start: later starts log the saved reason and
skip until `t3 doctor`, Settings' Reclaim, or deleting the file. The fleet's servers have no
Reclaim button, and Settings shows them only the `t3 doctor` command, so the server log is where
the reason appears. A database another process holds open is retried for ten seconds, then left
for the next start.

### Why at start

The fleet's `app-deployment-t3code` unit is `Type = simple`, so systemd's start timeout does not
apply once the process runs. The release health check waits 1800 s for `/healthz` (`project.nix`),
the same window migrations use. VACUUM time grows with the live data, about 30 s per GiB by the
estimate in `databaseReclaimMinutes`. dev-hauke's 10.5 GiB of live data means about six minutes
before the server listens, once: afterwards auto_vacuum is incremental and the condition no longer
holds. The VACUUM runs synchronously on the main thread, so a stop during it ends in SIGKILL after
30 s. SQLite rolls the VACUUM back, and `reclaim-failed` stays.

It needs free disk space of about twice the live data, like Reclaim: 23.2 GiB on dev-hauke, which
had 133 GB free once its checkouts were cleaned up. A start without room logs the shortfall and
serves without the repair.

## Removal

Drop this once every fleet database uses incremental auto_vacuum (`PRAGMA auto_vacuum` returns 2),
or once upstream VACUUMs existing databases itself.

## Verification

`DatabaseMaintenance.test.ts`: "vacuums at start only a database without auto_vacuum that frees
enough".
