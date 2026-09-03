# Desktop Packaging

## Purpose

Keep the packaged desktop app self-contained for runtime dependencies that publish platform-specific native
packages as optional dependencies.

## Requirements

- The staged desktop runtime install must include production dependencies and compatible optional dependencies.
- The install must not use `--no-optional`; desktop preview dependencies such as `react-grab` transitively load
  `ffi-rs`, whose native package (`@yuuang/ffi-rs-darwin-arm64` on Apple Silicon macOS) is optional in package
  metadata but required at runtime.
- The generated app bundle must start its backend child process without relying on the developer workspace's
  `node_modules`.

## Verification

- `scripts/build-desktop-artifact.test.ts` asserts the staged install arguments.
- `just desktop-macos` should produce and install a macOS app whose backend process reaches the HTTP readiness
  endpoint instead of crash-looping with `MODULE_NOT_FOUND`.
