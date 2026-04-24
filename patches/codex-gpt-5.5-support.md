# Codex GPT-5.5 Support

## Goal

Let this fork treat `gpt-5.5` as the default Codex model while keeping the patch minimal and easy to carry forward.

## Requirements

- Keep the Codex provider model catalog dynamic and sourced from `codex app-server model/list`.
- Do not hardcode a new Codex model list inside T3 Code.
- Update the shared Codex default model from `gpt-5.4` to `gpt-5.5`.
- Normalize older Codex-facing aliases such as `gpt-5` and `gpt-5-codex` to `gpt-5.5` so existing local settings and saved selections continue to resolve cleanly.
- Leave non-Codex providers unchanged.
- Leave the separate git text-generation default unchanged unless a later patch has a reason to move it.
- Cover the alias/default behavior with focused unit tests only.

## Upstream Reference

- Verified against `openai/codex` HEAD `c10f95ddac7b35095d334dece2ebcf69bcde61fc` on 2026-04-24.
- `codex-rs/models-manager/models.json` includes `gpt-5.5` with `"isDefault": true`.
- `codex-rs/models-manager/src/manager.rs` selects the default model from the upstream `is_default` flag rather than from a separate hardcoded picker in the app server.
- `codex-rs/tui/src/model_migration.rs` still contains migration prompts for older `gpt-5-codex` slugs, which supports keeping legacy alias normalization in this fork.

## Non-Goals

- No provider protocol changes.
- No persistence migrations.
- No UI redesign for the model picker.
- No attempt to backfill existing stored selections in-place when alias normalization already handles them at read time.
