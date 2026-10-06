# Separate project environments

Directories registered with the infra `agent-exec` launcher run their agents inside a separate
filesystem environment, while T3 Code itself stays on the host. On srv-2 this covers the fork's
separate projects and every isolated workspace created before the orchestration v2 merge, so
continuing those threads must keep working. Upstream has no project execution backend.

## Requirements

- Read registrations at `$AGENT_EXEC_STATE/projects/<sha256(canonical-root)[:20]>.json`, defaulting
  to `~/.local/state/agent-exec`. Records carry `version: 1`, `root`, `projectId`, and optionally
  `home` and `workspace.visibleRoot`. A cwd is registered when one of its canonical ancestors is.
- Run registered commands as `<launcher> auto --cwd <cwd> -- <executable> <args...>`, with
  arguments kept separate. Unregistered commands never touch the launcher. A registered cwd without
  `T3CODE_EXECUTION_LAUNCHER` fails; it never falls back to host execution.
- Route every process entry point: provider subprocesses and text generation through
  `ProviderProcessSpawner`, the Claude SDK through `separateProjectSpawn`, `ProcessRunner`, and
  `TerminalManager`.
- Codex and Claude v2 sessions use the host cwd for the subprocess and the visible cwd in thread
  and turn parameters (`CodexAdapterV2.ts`, `ClaudeAdapterV2.ts`). Local MCP URLs use the
  environment's host gateway, because v2 reaches its orchestration and preview tools over MCP.
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
launcher, every new workspace is an `agent-exec fork` registered here, so the routing above runs
its providers, terminals and setup scripts inside it.

## Not carried after the v2 merge

Creating a separate project from T3 (`project.create.separateEnvironment`, `t3 project add
--separate`, `separateProjectsSupported`) went away. The pre-merge requirements are in
`git show 49e8d42dbde4:patches/separate-project-environments.md`. Claude's native fork and
subagent helpers still pass the host cwd, and native forks with private provider homes remain
unverified.

## Upstream maintenance

Keep the helpers in `project/ProjectExecution.ts` and `project/SeparateProjectRegistry.ts`, and keep
the hooks in upstream-owned files to single calls. If upstream adds a project execution backend,
move these adapters onto it. See [project execution](../docs/internals/project-execution.md).
