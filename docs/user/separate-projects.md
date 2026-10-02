# Separate project environments

On hosts with the `agent-exec` launcher, a project directory registered with it runs its agents
in a separate environment. The agent gets private runtime state and the project's own development
tools. Global integrations and network access stay available. T3 Code detects registered
directories on its own, including workspaces created by earlier versions.

Only Codex and Claude can run in a separate environment. Starting a thread there with another
provider fails with a message asking you to switch. While a directory is registered, you can't
move its project to another folder in project settings. Ask for outside help to migrate it.

This version can't create new separate projects or workspaces from T3 Code.

Agents can use `agent-service` to run and publish project previews. Service names are scoped to
the project.

Separate environments keep nearby project directories from becoming incidental examples. They are
not a security sandbox.
