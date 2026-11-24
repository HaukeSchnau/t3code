# Worlds

A world shows every repository of one area of work at one path, such as `~/Buildlinx`, without
cloning any of them. Each thread in a world gets its own copy of that path. Agents read and search
any repository there right away, and a repository is checked out for that thread the first time
the agent writes to it or changes into it. Other threads never see those changes.

Worlds need a Linux server with the worldfs daemon and agent-exec, as T3's Linux release and the
fleet's hosts provide.

## Set up a world

Worlds come from the server's settings, so set them once per server, for example with
`t3 settings patch`:

```json
{
  "worlds": {
    "buildlinx": {
      "title": "BuildlinX",
      "path": "/home/me/Buildlinx",
      "layout": [{ "prefix": "git.buildlinx.io/", "dir": "Repos/" }]
    }
  }
}
```

- The key (`buildlinx`) is the world's name in the machine cache (`/var/lib/worlds/buildlinx`).
- `path` is where every thread sees the world.
- `layout` places repositories by forge path. Without a matching rule a repository sits at its
  forge path, such as `git.schnau.dev/schnau/t3code`.
- `worldfsSocket` names the daemon's socket when it isn't at
  `$XDG_RUNTIME_DIR/worldfs/ctl.sock`.

The server then adds a project for each world. Removing a world from the settings leaves its
project and threads in place.

## Work in a world

Start a thread in the world's project as usual. There is no workspace to choose: every thread gets
its own world.

The thread's details panel, and the thread menu on the phone, show the world:

- each repository the thread touched, and whether it is checked out;
- work no remote has yet, such as changed files, unpushed commits, or local branches with
  unpushed commits;
- checkouts the cap refused, with the repository and the tool that tried.

A thread may check out 20 repositories freely, then 10 a minute, and none past 50 repositories or
10 GB. Claude is told when a command would run on the read-only view, and doesn't work around it.
Agents read the same state with `t3_worktree_status`.

## When a thread is done

A settled, archived or deleted thread's world is removed after six quiet hours, but never while
it holds changed files or commits no remote has, or files outside its repositories. Push or drop
that work, and the world goes on the next pass. Local branches live in the machine's shared cache
and outlast the world. Sending a message to a thread whose world was removed gives it a
fresh one at the same path.
