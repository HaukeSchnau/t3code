# Project execution

The optional `agent-exec` launcher is an environment capability owned by the companion infra
repository. It owns project registration, private runtime state, mounts, and the preview bridge.
T3 Code only reads registrations (`project/SeparateProjectRegistry.ts`) and routes processes for
registered directories through the launcher (`project/ProjectExecution.ts`).

Registrations are keyed by canonical root, so T3 walks a cwd's ancestors to find one. An
unregistered cwd never touches the launcher. A registered cwd whose launcher is missing fails
instead of falling back to host execution.

Every process entry point resolves execution before spawning: `ProviderProcessSpawner` for
provider subprocesses and text generation, `ProcessRunner`, and `TerminalManager`. The Claude SDK
spawns through `separateProjectSpawn`.

The server stays on the host. Provider traffic continues over stdio, so the v2 adapters keep the
host cwd for the subprocess but show the agent its visible cwd (`workspace.visibleRoot`) in thread
and turn parameters. Local MCP URLs are rewritten to the environment's host gateway, because v2
reaches every orchestration and preview tool over the `t3-code` MCP endpoint. Files the agent names
by an environment path resolve through `projectHostPath` in `WorkspaceFileSystem` and
`AssetAccess` before T3 reads them.

`ProviderSessionManager` admits only the Codex and Claude drivers in registered directories, since
their execution paths are the only verified ones. `ProjectService.update` refuses to move a
registered project's root, because the registration is keyed by that root.
