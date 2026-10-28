# Separate project environments

Directories registered with the `agent-exec` launcher (`native/agent-exec`, shipped in the Linux
Release) run their agents inside a separate filesystem environment, while T3 Code itself stays on the host. On srv-2 this covers the fork's
separate projects and every isolated workspace created before the orchestration v2 merge, so
continuing those threads must keep working. Upstream has no project execution backend.

## Requirements

- Read registrations at `$AGENT_EXEC_STATE/projects/<sha256(canonical-root)[:20]>.json`, defaulting
  to `~/.local/state/agent-exec`. Records carry `version: 1`, `root`, `projectId`, and optionally
  `home` and `workspace.visibleRoot`. A cwd is registered when one of its canonical ancestors is.
- Run registered commands as `<launcher> auto --cwd <cwd> -- <executable> <args...>`, with
  arguments kept separate. Unregistered commands never touch the launcher. A registered cwd without
  `T3CODE_EXECUTION_LAUNCHER` fails; it never falls back to host execution.
- Route every process entry point: provider subprocesses such as probes and text generation through
  `ProviderProcessSpawner`, `ProcessRunner`, and `TerminalManager`.
- Codex and Claude v2 sessions build the launcher command themselves, before upstream's agent scope
  wraps it, so the launcher runs inside the `systemd-run` scope. Inside the project environment,
  agent-exec replaces `XDG_RUNTIME_DIR` and drops the session bus, so a scope started there could
  not reach the user manager. Codex spawns that command without a cwd, so `ProviderProcessSpawner`
  does not route it again (`CodexAdapterV2.ts`). Claude points the SDK's executable at the
  launcher and starts it in upstream's process group from the host cwd
  (`withSeparateProjectLaunch` in `ClaudeAdapterV2.ts`).
- Codex and Claude show the agent its visible cwd in thread and turn parameters. Local MCP URLs use
  the environment's host gateway, because v2 reaches its orchestration and preview tools over MCP.
- Codex metadata probes (`withCodexAppServerClient` in `provider/CodexProvider.ts`) set
  `AGENT_EXEC_ENVIRONMENT=baseline`. Listing a project's skills needs its files and the provider
  credentials, not a devenv or flake setup that can take minutes.
- On a launcher host, Codex reports no session sharing (`separateProjectSessionCapabilities`), so
  each thread gets its own app-server. Upstream shares one per provider instance, and the launcher
  decides where a process runs only when it starts, so a shared process would run every thread
  wherever the first one opened it.
- `ProviderSessionManager` rejects other drivers in registered directories.
- Agent-reported environment paths resolve through `projectHostPath` in `WorkspaceFileSystem` and
  `AssetAccess`. Identical `/tmp` or project paths in different environments must never fall back to
  an arbitrary host file.
- `ProjectService.update` refuses to move a registered project's root.

This reduces accidental context discovery. It is not a security boundary.

New isolated workspaces return through [Workspaces](workspaces.md). On a host with the
launcher, a jj or directory workspace launched with `isolated: true` is an `agent-exec fork`
registered here, so the routing above runs its providers, terminals and setup scripts inside it.
Other new workspaces stay on the host. Git projects get upstream's worktrees; isolated workspaces
that earlier versions created by default, including those forked from Git projects, keep their
registrations, so their threads still run and the workspaces can still be deleted.

## Not carried after the v2 merge

Creating a separate project from T3 (`project.create.separateEnvironment`, `t3 project add
--separate`, `separateProjectsSupported`) went away. The pre-merge requirements are in
`git show 49e8d42dbde4:patches/separate-project-environments.md`. Claude's native fork and
subagent helpers still pass the host cwd, and native forks with private provider homes remain
unverified.

## Upstream maintenance

Upstream's agent scopes (`apps/server/src/process/agentScope.ts`) replaced the fork's provider
systemd scopes. Agents run in `app-t3code-agents-<hash>.slice` and terminals in
`app-t3code-agents.slice`; infra's limits and observability cgroup paths must follow those names.

Keep the helpers in `project/ProjectExecution.ts` and `project/SeparateProjectRegistry.ts`, and keep
the hooks in upstream-owned files to single calls. If upstream adds a project execution backend,
move these adapters onto it. See [project execution](../docs/internals/project-execution.md).
