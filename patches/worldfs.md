# worldfs

## Fork requirement

A fleet world shows every repository of an area of work at one path, like `~/Buildlinx` does
today, on any machine, without cloning them ([#191](https://git.schnau.dev/schnau/t3code/issues/191),
decisions 1, 7, 8 and 9). Agents read and search unopened repositories with their own tools, and a
repository checks out for one thread the moment that thread writes to it or changes into it.
Upstream has no notion of worlds, a machine cache or per-thread checkouts on demand.

## Behavior

`native/worldfs` is a Go daemon; its [README](../native/worldfs/README.md) holds the layout, the
control socket and the rules. In short:

- One read-only FUSE mount per machine serves every repository version of the machine cache that
  infra keeps in `/var/lib/worlds`. Each thread's mount namespaces bind the versions they show.
- A write, a `chdir`, `jj`, or a hook's `checkout` call checks the repository out into the thread
  world with `git read-tree -u` and a colocated jj repository, removes the view from that thread's
  namespaces only, and answers ESTALE so the kernel retries the call on the checkout.
- Checkouts are capped per thread (20 free, then 10 a minute, none past 50 or 10 GB), close again
  after 10 idle minutes when nothing would be lost, and pin the thread's version. Untouched
  repositories follow the catalog.
- `status` reports unpushed work across checkouts, worktree admin dirs and the mirrors'
  `refs/heads`; `teardown` refuses while any of it would be lost.
- The Linux Release ships the binary (`nix/worldfs.nix`, a payload in `flake.nix`). Infra runs it
  as the `worldfs` user unit and owns the machine cache.

This PR ships the daemon alone. agent-exec builds the thread namespaces from `binds` (PR 3), and
T3 registers thread worlds, installs the checkout hook and shows unpushed work (PR 4).

## Upstream touch points

None in upstream-owned code: `native/worldfs`, `nix/worldfs.nix`, the payload and package in
`flake.nix`, and the generated package list in `.calder/flake.ts`.

## What worlds replace later

Once the BuildlinX and Schnau worlds have replaced `~/Buildlinx` and the other umbrella
directories (decision 5 keeps both running until then), these fork additions have no remaining
caller and should go:

- agent-exec's directory projects: the unionfs-fuse overlay (`nix/agent-exec-unionfs-quiet.patch`),
  repository discovery with four-at-a-time cloning, and the `agent-workspace-files@` unit. A thread
  world does the same job per repository, at checkout speed, with nothing to clone.
- The guarded directory copy in [Workspaces](workspaces.md), whose only large user is the umbrella.
- The Librarian's `librarian_read_file` fallback through the forges, since every indexed
  repository is then a readable path ([Librarian](librarian.md)).

## Removal

Remove this when upstream ships lazy multi-repository workspaces on Linux, or when fleet worlds
are retired.
