# Skill packs

## Fork requirement

The fork needs one catalog of optional skill groups that users pick per thread, with project
defaults, and that Codex, Claude Code, and locally managed OpenCode sessions load the same way. The
companion Nix infrastructure supplies the catalog and the canonical skill directories through
`T3CODE_SKILL_CATALOG_PATH`. Core provider skills keep their native discovery and trigger behavior.
Upstream has no per-thread skill scoping at all.

How it works is in [docs/internals/skill-packs.md](../docs/internals/skill-packs.md).

## Fork-owned code

- Contracts and RPCs: `packages/contracts/src/skillPacks.ts`.
- Server: `apps/server/src/skills/` (catalog, provider scope registry, `SkillPacks` service) and
  migration `081_SkillPackThreadSelections.ts`, which copies v1 `projection_threads.skill_scope_json`.
- Clients: `packages/client-runtime/src/skillPacks.ts` and `state/skillPacks.ts`,
  `apps/web/src/state/skillPacks.ts`, `apps/web/src/components/chat/SkillPacksControl.tsx`,
  `apps/web/src/components/settings/ProjectSkillPacksSettings.tsx`, and
  `apps/mobile/src/features/threads/skill-packs-session.ts`, `SkillPacksSheetContent.tsx`,
  `apps/mobile/src/state/skill-packs.ts`.

## Upstream hooks

- `packages/contracts/src/{index,rpc,server}.ts`: export, RPC group entries, `skillPackCatalog`.
- `apps/server/src/ws.ts` and `auth/RpcAuthorization.ts`: handlers, catalog in the server config,
  scopes.
- `apps/server/src/orchestration-v2/runtimeLayer.ts`: provides `SkillPacks`.
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts`: `prepareTurn` before the session
  opens.
- `CodexAdapterV2.ts` (extra root after `initialize`, per-thread `skills.config`),
  `ClaudeAdapterV2.ts` (`plugins`), `OpenCodeAdapterV2.ts` (spawn environment).
- `apps/server/src/persistence/Migrations.ts` and the two migration manifest tests.
- `packages/client-runtime/src/operations/commands.ts` (draft packs before `launchThread`) and
  `rpc/client.ts` (subscription tag).
- Web: `ChatComposer.tsx` (first resting block), `ChatView.tsx` (control and draft bootstrap),
  `ProjectSettingsPanel.tsx` (Skills row).
- Mobile: `ThreadSettingsSheet.tsx` (Skills row and page), `ThreadComposer.tsx`,
  `new-task-flow-provider.tsx`, `use-composer-drafts.ts`, `thread-outbox-model.ts`,
  `use-thread-outbox-drain.ts`, `projectThreadStartTurn.ts`.

## Not carried after the v2 merge

The v1 `t3 thread create --skill-pack` flag and the thread-orchestration MCP field went away with
the v1 orchestration toolkit. Threads that agents create follow their parent or project instead.
The web control has no entry in the composer's overflow menu, so it is unreachable only when every
resting control is hidden.

## Upstream maintenance

Prefer an upstream provider-neutral skill-scoping API if one appears, keeping additive semantics,
Claude's native trigger loading, project defaults, and the shared scope state. Codex per-thread
skill roots would remove the process-wide root and the disable rules.
