# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

## Fork release pipeline

Pushes to the fork's Gitea `main` branch run
[`.gitea/workflows/project-release.yml`](../../.gitea/workflows/project-release.yml). The independent
format, type-check, test, and release-smoke jobs run in parallel. A separate dependency job builds the
web, server, and runtime pnpm stores immediately, so a stale fixed-output hash fails before the final
release contract. The release job runs only after every gate succeeds.

Dependency changes use one generated-file workflow:

```sh
pnpm run fork:lockfile
```

It regenerates the canonical lockfile with the pinned pnpm version, derives the production deploy lock,
computes the three filtered-store hashes concurrently, updates `flake.nix`, and verifies
`projectReleaseGate`. To refresh only the hashes, run
`vp run --workspace-root deps:nix-refresh`. To check the committed hashes without changing files, run
`just qa-nix-deps`.

Use `just ci-watch <revision>` after pushing. The watcher fetches `origin/main`, verifies that every new
head descends from the requested revision, and follows the newest matching Gitea run. If another push
supersedes and cancels a run, it moves to the descendant run instead of reporting the cancelled ancestor.

## Upstream GitHub pipeline

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs these quality gates on pull requests
and pushes to `main`:

- **Check**: `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists and
  uses only imports that Electron's sandbox can load. The verifier parses imports, then executes the
  trusted artifact with controlled bridge stubs to confirm that its required APIs are callable.
- **Test**: `vp run test` across the workspace.
- **Mobile Native Static Analysis**: `vp run lint:mobile` on macOS, wrapping
  `scripts/mobile-native-static-check.ts`. A cheap Linux **Mobile Native Changes** job gates it:
  the macOS runner only boots when the diff touches `apps/mobile` Swift/Kotlin sources, the
  SwiftLint/detekt/ktlint configuration, the `Brewfile`, the check script, the root `package.json`
  that defines `lint:mobile`, or `ci.yml`. Otherwise the job is skipped, which GitHub reports as
  success for the required check. Renames are matched on both their old and new path. The gate fails
  open in every other case: if the changed-file list cannot be resolved, GitHub truncates it, or the
  gate job itself fails, the lint runs.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts`, so
  release breakage surfaces on PRs rather than at tag time.

[`.github/workflows/windows-tests.yml`](../../.github/workflows/windows-tests.yml) is a manual
Windows lane (`workflow_dispatch` only) on a Blacksmith Windows 2025 runner. The suite does not
pass on Windows yet, so it is not a required check; it exists so the work to get there can be
iterated against a real Windows box without one on hand. Dispatch it with `gh workflow run
windows-tests.yml --ref <branch>`, optionally with `-f package=<dir>` to run one workspace package
and `-f files="<paths>"` to run specific test files inside it. Once it is green, fold it into
`ci.yml`.

`.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`)
desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release. It auto-enables
signing only when platform credentials are present. macOS passkey builds additionally require
`APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing.
Without the core signing credentials, it still releases unsigned artifacts.

Preflight shares pnpm's lockfile verification results with the desktop build jobs through a small
artifact. This avoids repeating dependency checks, especially on Windows, without transferring the
large registry metadata cache. pnpm checks the current lockfile and policy before it reuses a result.
If the artifact is unavailable, installation runs the checks again.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
