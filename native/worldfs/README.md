# worldfs

The Linux daemon behind fleet worlds ([#191](https://git.schnau.dev/schnau/t3code/issues/191),
decisions 1, 7, 8 and 9). It shows every repo in the machine cache as a read-only directory, and
checks a repo out for one thread the first time that thread writes to it or changes into it. T3's
Linux Release ships it as `bin/worldfs` (`nix/worldfs.nix`); infra's `worldfs` user unit runs it:

```sh
worldfs daemon --cache /var/lib/worlds --state ~/.local/state/worldfs
```

## Layout

| Path                                       | What                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<cache>/<world>/catalog.json`             | Infra's list of repos: forge path, default branch, newest commit whose tree is local, mirror. Re-read within `--poll` (30 s) of a change. |
| `<cache>/<world>/mirrors/<forge path>.git` | Infra's blobless mirrors. Upstream refs live in `refs/remotes/origin/*`; `refs/heads` belongs to threads.                                 |
| `<state>/mnt/views`                        | One FUSE mount for the machine. `<world>/<forge path>@<commit>` is a version of a repo; `.admin/<thread>` holds the thread's admin links. |
| `<state>/state.json`                       | Threads, and per repo each touched: version, phase, admin dir.                                                                            |
| `$RUNTIME_DIRECTORY/ctl.sock`              | The control socket (`--socket`).                                                                                                          |

A thread world is a host directory (`root`) that a thread sees at a canonical path (`path`). For
each repo the thread hasn't checked out, its namespaces bind the version's view directory over
`<path>/<dir>`. A checkout is a plain directory at `<root>/<dir>`: a git worktree of the mirror,
locked and registered on first use, with a colocated jj repo.

Every view's `.git` file says `gitdir: /run/worldfs/admin/<forge path>`. Each thread binds its
`.admin/<thread>` there. Looking up a link registers the thread's worktree in the mirror, with an
index whose stat data matches the view, so `git status` on a view is clean without reading a blob.
Only a process named `git` registers one: `grep -r` reads every `.git` file and ripgrep follows it
to `info/exclude`, and neither should cost a worktree per repo and thread.

## Checkouts

- **Triggers.** A write of any kind (open for writing, create, unlink, rename, mkdir, chmod and so
  on), a `chdir` (FUSE sends ACCESS with X_OK, so `access(dir, X_OK)` and `git -C` count too), a
  lookup of `.jj` by a process named `jj`, or `checkout` on the socket. Writes don't wait for jj;
  the others do.
- **How.** `git read-tree -u` of the thread's index (so anything staged on the view survives) into
  `<root>/<dir>`, without touching the network. The daemon sets every file's mtime to the commit
  time and writes the index from real stat data, so the first `git status` doesn't rehash the tree.
  Then it unmounts the view in every mount namespace of the thread and answers the trigger with
  ESTALE. The kernel retries the system call once, finds no view, and lands in the checkout. jj
  initializes in the background.
- **Which thread.** The user namespace that owns the caller's mount namespace (`NS_GET_USERNS`).
  agent-exec starts every launch in a new mount namespace inside one holder user namespace, so all
  launches of a thread share it. To change mounts the daemon joins that owner with `nsenter` and
  runs `worldfs ns-mount`, so the binary has to be visible inside (it is, under `/nix`).
- **Limits.** Per thread, 20 checkouts never wait, then 10 a minute; past 50 repos or 10 GB the
  write gets EROFS and the socket answers `cap` with a readable reason. `force` skips both.
- **Idle close.** Every minute, a checkout that is 10 minutes old, unchanged for 10 minutes, has
  no process with a cwd, root or open file in it, no changes, no ignored files, a HEAD some remote
  has, and no jj commits off the remote bookmarks besides an empty `@`, goes back to the view. It
  puts the view over the checkout in every namespace, checks all of that again, and only then
  deletes the files.
- **Versions.** A thread follows the catalog for a repo until it checks it out or moves its HEAD;
  a checkout pins the version, also after an idle close. When the catalog moves, the daemon
  advances a follower's HEAD and index under git's `index.lock` and swaps the bind with
  `MOVE_MOUNT_BENEATH` (Linux 6.5), so no lookup sees an empty directory in between.

## Control socket

One JSON request per line and one JSON response per line, one request per connection.
`worldfs ctl '<json>'` sends one and exits 2 on a refusal. A failure is
`{"ok": false, "error": {"code", "message"}}`, and `message` is meant to be shown as it is. A
caller inside a thread (any mount namespace but the daemon's) may only use `checkout`, `status`,
`close`, `sync` and `stats`, on its own thread.

| Method     | Params                                                                                                                                                   | Result                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register` | `thread`, `world`, `root`, `path`, `pid` (a process in the thread's user namespace, such as agent-exec's holder), optional `layout: [{"prefix", "dir"}]` | `binds`. Idempotent; a new `pid` moves the thread to a new holder.                                                                                                                         |
| `binds`    | `thread`                                                                                                                                                 | The ordered binds for a new launch: the world, the views mount's parent, the admin links, the cache, the socket's directory, and one view per repo not checked out.                        |
| `checkout` | `path` (inside the thread or under `root`) or `repo`; `thread` (default: the caller's, by SO_PEERCRED); `force`                                          | `repo`, `dir`, `ms`. Codes: `cap`, `outside`, `not-in-thread`, `unknown-repo`, `missing-objects`, `failed`.                                                                                |
| `status`   | `thread`                                                                                                                                                 | Each touched repo with `state`, `version`, `following`, `dirty`, `commits`, `jjCommits`, unpushed `branches` and `lostOnTeardown`; totals; recent refusals with the process.               |
| `close`    | `thread`, `repo`                                                                                                                                         | Codes: `work`, `busy`, `not-checked-out`.                                                                                                                                                  |
| `teardown` | `thread`                                                                                                                                                 | Codes: `live`, `work`. Branches in `refs/heads` survive; they live in the mirror.                                                                                                          |
| `sync`     | `thread`                                                                                                                                                 | Applies checkouts and catalog moves to every live namespace of the thread. A launch calls it from its new namespace before it starts the command, so nothing that raced `binds` is missed. |
| `stats`    |                                                                                                                                                          | `revision`, a pending `upgrade` (`revision`, `since`, `waitingFor`), repos, threads, RSS, OS threads, fds.                                                                                 |

A repo lands at `<path>/<dir><rest>` for the longest matching `layout` prefix, else at
`<path>/<forge path>`.

## Crash recovery

`state.json` records a phase per repo before each step, and a step that exposes a checkout or
deletes files only runs once its phase is saved. On start the daemon lazily unmounts a dead
`mnt/views`, mounts a new one, and then:

- rolls back any checkout not yet recorded as done, restoring the view's index (the view still
  covered the directory, so only read-tree wrote there);
- keeps the checkout of an interrupted close, since files may have changed after its checks;
- finishes moving a follower's HEAD and index to a catalog commit;
- reruns a jj init that never finished, adopts a worktree registered just before a crash, and
  advances followers to catalog changes made while it was down;
- swaps every thread namespace's binds, admin links included, onto the new mount.

Namespaces see the new mount because agent-exec binds the parent of `mnt/views`, which receives
host mount events.

## Upgrades

The daemon follows its Release without a restart by systemd. On every poll it asks the command it
was started as (infra's `current/bin/worldfs`) for its revision with `worldfs version`, again only
once that command resolves to another file. When the revision differs from its own, `stats` lists
the upgrade as pending, with the threads it waits for.

The daemon waits until no thread has a live mount namespace and none called `register` or `binds`
in the last minute. A restart detaches every live namespace's views until the new daemon rebinds
them, and a file a process holds open in a view stays dead. A thread without a live namespace has
nothing to lose: its next launch gets its binds from the new daemon.

Then it stops accepting connections, waits for the requests and jj inits in flight, and executes
the command in its own process, passing the control socket's listener in `WORLDFS_LISTEN_FD`.
Callers that connect meanwhile wait in the listener's backlog. The new process starts as after a
crash (above), with the listener it was given. systemd sees the same main process throughout.

`nix/worldfs.nix` sets the revision to the store hash of the daemon's source. A Release that
changes no file in `native/worldfs` leaves the daemon alone, and hosts that run the same source
report the same revision.

## Tests

`go test ./...` covers the cap and throttle, idle close, unpushed-work status, catalog refresh,
recovery, teardown and when an upgrade runs, with real git and jj. `TestIntegration` runs the daemon against real FUSE
and bwrap namespaces built like agent-exec's, up to an upgrade to another build; it needs `/dev/fuse`, user namespaces, `bwrap`,
`unshare` and `nsenter`, so CI skips it:

```sh
WORLDFS_INTEGRATION=1 go test -run Integration -v .
```
