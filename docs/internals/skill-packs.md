# Skill packs

Skill packs let a T3 environment expose optional groups of provider-native skills. Core skills stay
available through the provider's normal discovery path; selecting a pack adds its skills to one
thread. Profiles are catalog shortcuts that expand to pack IDs in the client and are not persisted
as a second kind of scope.

## Catalog boundary

The server reads `T3CODE_SKILL_CATALOG_PATH` at startup. The JSON catalog owns stable skill, pack,
and profile IDs and maps each skill to its canonical directory. Runtime paths are server-only. The
configuration snapshot sent to clients contains labels, descriptions, source links, memberships,
and core-skill IDs, but never the canonical filesystem paths.

Project metadata can store default pack IDs. A new thread inherits those defaults unless its create
request contains an explicit selection. Forks inherit the source thread's selection. The persisted
thread scope records a desired version, the last applied version, and `pending`, `ready`, or
`degraded` state so every client sees the same activation result.

## Provider injection

For a non-empty selection, the server resolves catalog entries and materializes a content-addressed
directory under T3 state:

```text
skill-scopes/<digest>/
  .claude-plugin/plugin.json
  skills/<skill-id> -> <canonical skill directory>
```

The provider adapters consume that directory without copying skill content:

- Codex calls `skills/extraRoots/set` before opening or resuming the thread.
- Claude Code mounts the directory as a local plugin. T3 deliberately leaves the SDK `skills`
  allowlist unset so Claude's native trigger-based loading remains intact.
- A locally managed OpenCode server receives the skill directory through
  `OPENCODE_CONFIG_CONTENT.skills.paths`, merged with caller-owned configuration.
- External OpenCode servers and other provider drivers report a degraded scope because their
  process or filesystem boundary cannot receive the local directory.

Changing a running thread's selection restarts its provider session using its normal resume cursor,
then marks the requested version applied. A failed catalog lookup or provider injection degrades the
scope without pretending the selected skills are active.

## Client behavior

Web, desktop, and mobile use shared catalog helpers from `packages/client-runtime`. The composer
shows a compact pack control, project settings edit defaults, and provider capability warnings are
derived from the server provider snapshot. `$skill` and slash-command discovery remain separate,
one-turn provider features; pack selection changes persistent thread scope.
