# Separate project environments

Fresh projects can opt into an infra-managed filesystem environment while retaining global agent instructions, skills, authentication, and network access. The host T3 server retains its normal access.

## Contract and ownership

- `project.create.separateEnvironment` asks deferred server preprocessing to run `T3CODE_EXECUTION_LAUNCHER create <canonical-root> --project-id <id>`. The launcher rejects nonempty directories and makes retries for the same project identity idempotent.
- `server.getConfig.separateProjectsSupported` advertises creation support. Web/desktop and mobile only offer the option on those servers. `t3 project add --separate` requires a running server.
- Infra owns the `agent-exec` package, filesystem mounts, authentication materialization, project registry, preview bridge, and outside-help command. T3 owns project creation, provider sessions, terminal lifetime, and process routing.
- Registrations live at `$AGENT_EXEC_STATE/projects/<sha256(canonical-root)[:20]>.json`, defaulting to `~/.local/state/agent-exec`. Records include `version: 1`, `root`, and `projectId`. They are outside the agent's filesystem view. T3 walks canonical cwd ancestors to discover them and refuses settings-driven root moves.
- Registered commands run as `<launcher> auto --cwd <cwd> -- <executable> <args...>`. Arguments remain separate; the launcher is not a shell expression. Unregistered commands avoid the launcher entirely.
- Provider subprocesses, Claude SDK subprocesses, ProcessRunner commands, terminals, and setup scripts use project execution. Infra's project-scoped `agent-service` bridge launches previews through the same runtime.

## Initial limits

Codex (`codex`) and Claude/Claudex (`claudeAgent`) are supported. Other providers are rejected for registered projects until their execution paths are verified. The project-level creation toggle is retained only as a legacy CLI/protocol path. New managed workspaces use the existing workspace service and fork through this runtime. A registered source can create another isolated workspace; it cannot silently downgrade to a host checkout. Native session forks/imports are not verified for private provider homes.

This feature reduces accidental context discovery. It is not a security boundary: network access, Nix's daemon, global plugins, personal integrations, and explicit T3 thread tools remain available. T3's attachment directory is read-only and shared so attachments added after provider startup remain readable. Source project directories and T3's database/transcripts are not mounted.

## Upstream maintenance

Keep the creation field, capability advertisement, all process entry points, and the registry guards together. If upstream introduces a project execution backend, move these adapters onto it. Never advertise separate execution while silently falling back to host execution.

Independent jj environments are an opt-in infra launcher mode. The registry's optional `workspace.visibleRoot` gives the agent-visible path; T3 retains the canonical host root as the project/session identity. Codex thread startup and Claude SDK options use the visible cwd, while subprocess launch uses the host cwd. Local MCP endpoints use the environment's host gateway. This is intentionally coupled to the private runtime rather than a generic container abstraction.

File reads, media grants and observed image persistence resolve namespace paths using the owning thread's workspace registration. Identical `/tmp` or project paths in different environments must never fall back to an arbitrary host file. Provider image paths remain unchanged in the transcript; their stored bytes or grants refer to the resolved file. The launcher owns jj cloning/collection, declarative devShell activation, private networking, and lifecycle; the existing workspace service and picker select this runtime through their isolated backend. See [Workspaces](workspaces.md) for membership and settlement behavior.
