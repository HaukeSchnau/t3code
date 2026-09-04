# Skill packs

## Fork requirement

This fork needs one catalog of optional skill groups that users can select in T3 Code and apply
consistently to Codex, Claude Code, and locally managed OpenCode sessions. The catalog and canonical
skill directories are supplied by the companion Nix infrastructure. Core provider skills must keep
their native discovery and trigger behavior.

## Implementation

- Read the configured catalog from `T3CODE_SKILL_CATALOG_PATH` and publish only its path-free client
  projection.
- Persist project defaults and versioned per-thread pack selections in orchestration state.
- Materialize selected skills once as content-addressed symlink trees and a Claude local plugin.
- Inject the tree through Codex extra roots, Claude local plugins, or local OpenCode config paths.
  Do not set Claude's SDK skill allowlist or add prompt instructions that force skill activation.
- Mark unsupported providers and external OpenCode servers degraded while leaving their native
  skills untouched.
- Keep web, desktop, mobile, orchestration tools, and the `t3 thread create --skill-pack` CLI on the
  same contract.

## Infrastructure dependency

The server remains usable without a catalog, but selected packs degrade until the environment sets
`T3CODE_SKILL_CATALOG_PATH` to a valid version-1 catalog. Skill IDs and paths in that catalog must
match the directories installed on the server host.

## Upstream maintenance

Prefer an upstream provider-neutral skill-scoping API if one becomes available. Preserve the
additive semantics, Claude's native trigger loading, project defaults, and multi-client scope state
when replacing this patch.
