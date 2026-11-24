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
      "repo": "git@git.example.com:me/world-buildlinx.git",
      "mounts": ["/mnt/world-stores/buildlinx"]
    }
  }
}
```

- The key (`buildlinx`) is the world's name in the machine cache (`/var/lib/worlds/buildlinx`).
- `path` is where every thread sees the world.
- `repo` is the world repo, a small git repository the server clones as the top of each thread's
  world. It holds the world's `AGENTS.md`, the notes threads share in `agent-notes/`, and
  `world.json`. Without it a thread's world starts empty at the top.
- `mounts` are paths on the server every thread of the world reads at the same path, read-only,
  for material that must never enter git.

`world.json` places repositories by forge path and names files that must never leave the machine:

```json
{
  "layout": [{ "prefix": "git.example.com/", "dir": "Repos/" }],
  "neverCommit": ["**/evidence/**", "*.qcow2"]
}
```

Without a matching layout rule a repository sits at its forge path, such as
`git.schnau.dev/schnau/t3code`. Give the world repo a `.gitignore` that keeps only what it holds
(`/*` and then `!/AGENTS.md`, `!/agent-notes/` and so on), and a `.gitattributes` with
`agent-notes/** merge=union`, so two threads' edits to one text note merge on their own. A
conflict that remains, such as in an image, keeps the thread's commits for you to resolve.

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

## Notes

At the end of every turn of a world with a `repo` the server commits the thread's changes to the world repo, merges what
other threads pushed, and pushes. A file `world.json` lists in `neverCommit`, a file over 1 MiB
and a private key stay out of the commit, and the world's state shows them as changes with the
reason. A commit made in the thread that holds one stops the push until the file is taken out of that commit; deleting it in a later commit isn't enough.

## When a thread is done

A settled, archived or deleted thread's world is removed after six quiet hours, but never while
it holds changed files or commits no remote has, notes not yet pushed, or files outside its
repositories and the world repo. Push or drop
that work, and the world goes on the next pass. Local branches of the world's repositories live in the machine's shared cache and outlast the world;
branches in the world repo itself go with it, so push those you want to keep. Sending a message to a thread whose world was removed gives it a
fresh one at the same path.
