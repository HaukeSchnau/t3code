# Separate project environments

On hosts with the `agent-exec` launcher, a project directory registered with it runs its agents
in a separate environment. The agent gets private runtime state and the project's own development
tools. Global integrations and network access stay available. T3 Code detects registered
directories on its own, including workspaces created by earlier versions.

Only Codex and Claude can run in a separate environment. Starting a thread there with another
provider fails with a message asking you to switch. While a directory is registered, you can't
move its project to another folder in project settings. Ask for outside help to migrate it.

On these hosts, **New isolated workspace** in the composer's workspace control creates a
separate environment for one task in a jj repository or a folder without Git, with its own
checkout of the project's repositories. Use it for clean-room work, such as a rewrite that should
not borrow from the code around it. **New workspace** stays an ordinary folder on the host, and Git
projects get ordinary worktrees. In a project that is itself a separate environment, every new
workspace is one too. The choice applies to the next task you send. Under **Clean room
setup**, **Familiar** keeps your global instructions and skills; **Minimal** starts with the
project's own guidance. Agents opt in with `isolated: true` in a `workspace` launch. Deleting the
workspace stops its environment and removes its files. This version can't create new separate
projects from T3 Code.

Agents can use `agent-service` to run and publish project previews. Service names are scoped to
the project.

Separate environments keep nearby project directories from becoming incidental examples. They are
not a security sandbox.
