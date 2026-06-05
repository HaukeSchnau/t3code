# Dependency Patches

## Goal

Document package-manager patches that keep the fork building and running with the current Vite+,
Effect, Expo/Metro, and React Native setup.

## Source Context

- Backfilled from the current `patches/*.patch` files and the fork delta against `main@upstream`.
- These patches are package-manager patches, not application features. Revisit each patch whenever
  the dependency version changes.

## Patched Packages

### `@effect/vitest@4.0.0-beta.78`

Patch file: `patches/@effect__vitest@4.0.0-beta.78.patch`

Requirements:

- Import and re-export Vitest APIs from `vite-plus/test` instead of `vitest`.
- Read the current suite from `vite-plus/test/plugins/runner` instead of `@vitest/runner`.
- Keep Effect test helpers compatible with the repo's Vite+ test runtime.

Revisit when:

- `@effect/vitest` natively supports Vite+.
- The Vite+ test import paths change.

### `effect@4.0.0-beta.78`

Patch file: `patches/effect@4.0.0-beta.78.patch`

Requirements:

- Add RPC client request hooks for request start, stream chunks, request exit, and request
  interrupt.
- Preserve request tags for interrupt reporting.
- Add connection hook support for ping, pong, and ping timeout.
- Keep these hooks optional so existing Effect RPC clients behave unchanged.
- Use the hooks for observability/debugging without changing application protocol payloads.

Revisit when:

- Effect exposes equivalent RPC request/connection hook APIs.
- RPC transport internals change around request entries, pingers, or stream queues.

### `@expo/metro-config@56.0.13`

Patch file: `patches/@expo%2Fmetro-config@56.0.13.patch`

Requirements:

- Sanitize Hermes/Metro source maps before source-map composition.
- Drop invalid original mapping segments that point beyond the previous generated map's line count.
- Keep normal source-map composition behavior unchanged when no invalid segments exist.

Revisit when:

- Expo/Metro fixes Hermes trailer/debug-line mappings upstream.
- Metro source-map composition internals change.

### `@pierre/diffs@1.1.20`

Patch file: `patches/@pierre%2Fdiffs@1.1.20.patch`

Requirements:

- Add missing package exports for:
  - `./types`
  - `./utils/getFiletypeFromFileName`
  - `./utils/parsePatchFiles`
- Keep imports on package subpaths instead of reaching into unexported internals.

Revisit when:

- `@pierre/diffs` publishes these exports upstream.
- The diff parsing integration moves away from these subpaths.

### `react-native-nitro-modules@0.35.9`

Patch file: `patches/react-native-nitro-modules@0.35.9.patch`

Requirements:

- Add the iOS Nitro modules provider mapping:
  - provider name: `NitroModules`
  - native class: `NativeNitroModules`
- Keep React Native iOS autolinking/codegen aware of the native provider.

Revisit when:

- `react-native-nitro-modules` publishes the iOS provider metadata upstream.
- React Native's Nitro module provider registration changes.

## Non-Goals

- Do not edit vendored dependency source directly.
- Do not import from patched package internals when an exported path exists.
- Do not carry stale patch files after upgrading dependencies.

## Verification

- `vp check`
- `vp run typecheck`
- Targeted package tests for affected areas:
  - Effect/Vite+ tests for `@effect/vitest`
  - RPC/transport tests for `effect`
  - mobile bundling/source-map checks for Expo/Metro
  - diff parsing tests for `@pierre/diffs`
  - iOS build/codegen checks for Nitro modules
