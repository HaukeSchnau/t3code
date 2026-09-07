# Start a project in a separate environment

When adding a local folder on a supported server, enable **Separate environment** and choose a new or empty directory. In the web and desktop apps, the option appears in the folder picker's footer. On mobile, it appears below the path field.

Your agent keeps its normal instructions, skills, development tools, authentication, and network access. Other project directories are absent from its filesystem view. Threads in the project share its files and private runtime home across restarts.

Use a Codex or Claude provider and the **Local** thread option. Managed workspaces and other providers are not supported yet. Native session forks have not been verified with separate provider homes.

From the CLI:

```sh
t3 project add ~/Code/my-new-project --separate
```

The server must be running. Existing nonempty projects cannot be converted using this command.

Agents can use `agent-service` to run and publish project previews. Service names are scoped to the project. For host tooling or infrastructure problems, they can run:

```sh
agent-help "Describe the problem, failing command, and relevant output"
```

This creates a linked support thread in the host's infra project and registers a durable wait that reports its result back. You can inspect both threads in T3. It does not grant the support agent additional authorization.

Global integrations and network access remain available, so an agent can deliberately retrieve outside context. Separate environments prevent nearby project directories from becoming incidental examples; they are not intended as a security sandbox.
