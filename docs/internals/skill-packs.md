# Skill packs

Skill packs let an environment offer optional groups of provider-native skills. Core skills keep
their native discovery. A pack adds its skills to one thread. Profiles are catalog shortcuts that
the client expands to pack IDs, so the server only ever stores pack IDs.

## Catalog boundary

The server reads `T3CODE_SKILL_CATALOG_PATH` once at startup
([`SkillPacks.ts`](../../apps/server/src/skills/SkillPacks.ts)). The JSON catalog maps stable
skill, pack, and profile IDs to canonical skill directories. Clients get `skillPackCatalog` in the
server config without any paths, and every surface hides the feature when it is absent. A catalog
change needs a server restart, which a changed environment variable forces anyway.

## Selection

A thread's packs live in the fork table `skill_pack_thread_selections` (migration 81), next to the
pack IDs the provider last received and the issue from that attempt. A project's default lives in
`projection_projects.default_skill_pack_ids_json`, which v2's `ProjectStore` never writes, so its
upserts leave the column alone.

A thread without a row follows its fork parent's packs, then its project default. The first turn
writes the row, so later project default changes leave started threads alone. This also covers
forks, delegated children, and imported threads without hooks in their creation paths. A draft
sends its picks through `skillPacks.setThreadPacks` before `launchThread`, so they are stored
before the first turn opens the provider session.

The scope a client sees is derived on read. It is `pending` while the stored packs differ from the
packs the provider last received, `degraded` when that attempt left an issue, and `ready`
otherwise. `skillPacks.subscribe` streams it per project and thread.

## Provider injection

`SkillPacks.prepareTurn` runs in `ProviderTurnStartService` before the session opens. It resolves
the packs, links the selected skills into a content-addressed directory, and hands the result to
the adapters through [`SkillPackProviderScope.ts`](../../apps/server/src/skills/SkillPackProviderScope.ts),
the same way adapters read `McpProviderSession`.

```text
<stateDir>/skill-scopes/<digest>/
  .claude-plugin/plugin.json      name "skills"
  skills/<skill-id> -> <canonical skill directory>
```

Core skills are left out of these directories because the providers already load them.
`agent-exec` bind-mounts `skill-scopes` into isolated project environments, so the links must stay
under the state directory.

- Codex runs one app-server per instance for every thread, and `skills/extraRoots/set` applies to
  the whole process. The process therefore loads every pack skill from one root, and each thread's
  `thread/start`, `thread/resume`, and `thread/fork` config disables the pack skills it did not
  select through `skills.config` path rules. Codex canonicalizes both the rule and the loaded
  skill path, so the symlinked path matches.
- Claude Code mounts the directory as a local plugin, which exposes skills as `skills:<id>`. The SDK
  `skills` allowlist stays unset so Claude's own trigger loading keeps working.
- OpenCode 1.x spawns one server per thread and gets the directory through
  `OPENCODE_CONFIG_CONTENT.skills.paths`, merged with caller config.
- OpenCode 2 serves every thread from one server, an external OpenCode server cannot see local
  paths, and the remaining providers have no injection point. These report a degraded scope and
  keep their native skills.

Every adapter read records the key it loaded. When the next turn's selection differs from that key,
`prepareTurn` detaches the thread from its provider session. A single-thread session closes, and a
shared Codex session unloads just that thread, so the turn reloads it with the new packs and its
resume cursor. Failures never block a turn; they degrade the scope.
