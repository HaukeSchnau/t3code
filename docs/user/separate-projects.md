# Work in a separate workspace

Choose **New workspace** in the composer to start with separate files and a private runtime on a supported server. Web, desktop and mobile use the same workspace selection. Choose an existing workspace to share its files with another thread, or **Project checkout** to work in the original directory.

Advanced setup offers Familiar, which includes your global instructions and skills, and Minimal, which starts with project instructions. Both keep account integrations, network access and project development tools. Each thread keeps its own conversation; threads sharing a workspace share files and services.

Use a Codex or Claude provider for isolated execution. Projects can be Git/jj repositories or directories containing repositories at any depth. Each discovered repository gets independent history and files. Ordinary files outside repositories are copied only when changed in the workspace; untouched files can reflect later changes in the original directory. Keep that source directory available while using its workspaces.

From the CLI:

```sh
t3 thread create --worktree
```

Pass `--workspace ID` to reuse a workspace. A workspace leaves the normal picker after all its threads settle or archive. Search or show settled workspaces to find it again. Its files and previews remain available. Deleting a workspace refuses active or running threads and asks the runtime to stop before removing its files.

Agents can use `agent-service` to run and publish project previews. Service names are scoped to the project. For host tooling or infrastructure problems, they can run:

```sh
agent-help "Describe the problem, failing command, and relevant output"
```

This creates a linked support thread in the host's infra project and registers a durable wait that reports its result back. You can inspect both threads in T3. It does not grant the support agent additional authorization.

Global integrations and network access remain available, so an agent can deliberately retrieve outside context. Separate environments prevent nearby project directories from becoming incidental examples; they are not intended as a security sandbox.
