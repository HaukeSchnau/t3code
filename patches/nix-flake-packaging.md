# Nix flake packaging

## Purpose

This fork ships a root `flake.nix` so the server can be built and deployed with Nix.
The flake exposes:

- `packages.default`: a packaged `t3` server with the bundled web client and production dependencies.
- `apps.t3`: a runnable `t3` app entrypoint. The flake intentionally has no default app.
- `packages.projectRelease`: the immutable server artifact and its idle-gated release actions.
- `project.nix`: shared typed requirements, parameters and release policy.
- `devenv.nix`: native dependency setup, web/server development and Metro, using the same pinned toolchain.
  Managed previews supply endpoint and per-instance state bindings. Standalone `devenv up` uses `.devenv`
  state and loopback endpoints. Generated JSON is an artifact, not a source file or manual export step.
- `devShells.default`: Node 24, pnpm 11.10, JJ, Git, SSH, and native build tooling.
- `nixosModules.default`: a `services.t3code` systemd service module for NixOS hosts.

Pushes to the fork's Gitea `main` branch call the shared Project Release workflow from the pinned public
infrastructure module. The workflow verifies `projectReleaseGate`, publishes the immutable closure to the
configured binary cache, and asks every infrastructure-owned placement to activate that exact revision.
GitHub remains a downstream code mirror and the home of the upstream project.

## Packaging behavior

The package follows the existing server publish flow, but models the web bundle, server bundle, and
production dependencies as independent derivations:

1. Install and build only the `@t3tools/web...` workspace dependency closure.
2. Install and build only the `t3...` workspace dependency closure for `apps/server/dist/bin.mjs`.
3. Use `pnpm deploy --prod --filter t3` to create an isolated production dependency tree.
4. Rebuild only `node-pty` from source, then remove packaged prebuild directories for other platforms.
5. Assemble the three immutable outputs in a tiny wrapper derivation and add Node plus common runtime tools
   to `PATH`.

The dependency fetches use pnpm's matching workspace filters instead of installing all workspaces. The runtime
uses pnpm's current injected-workspace deploy algorithm with the dedicated `pnpm-deploy-lock.yaml`; the normal
`pnpm-lock.yaml` and workspace configuration retain linked-workspace semantics for development installs.
`supportedArchitectures` is limited to the build platform, preventing foreign
Claude and native prebuilds from entering the result. `node-pty` is rebuilt explicitly because it needs a
platform-specific native module and its generic install script cannot run during the broad script-free
production install.

`pnpm-deploy-lock.yaml` is generated, not hand-edited. After changing a workspace manifest, run
`pnpm run fork:lockfile`; it regenerates and validates the canonical lockfile, derives the deploy lock,
refreshes the three fixed-output Nix hashes, and verifies `projectReleaseGate`. Review and commit the
generated files together. The scripts require the flake's pinned pnpm 11.10 and restore temporary edits even
when pnpm fails.

The three derivations deliberately have separate source filters. Web-only edits do not invalidate the server
bundle or runtime dependencies; server-only edits do not invalidate the web bundle; documentation changes do
not invalidate dependency fetches. Lockfile and manifest changes remain shared inputs because they can change
any dependency graph.

Production Nix builds disable web and server source maps. Local and development builds retain source maps by
default; set `T3CODE_WEB_SOURCEMAP=false` or `T3CODE_SERVER_SOURCEMAP=false` to reproduce the production mode.
Production configs use Vite without importing the test configuration. Vitest has dedicated config files, so
the test resolver plugin is not loaded during production bundling.
Upstream test setup belongs in these dedicated Vitest configs, including the shared temporary-directory
setup and the server Git configuration fixture.

The flake pins pnpm 11.10 and uses fetcher version 4 with `trustLockfile`. This avoids re-resolving and
re-verifying an already frozen lockfile while retaining Nix's fixed-output dependency hash as the integrity
boundary.

The build environment sets `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS` to nixpkgs' `cacert` bundle. Vite+'s
Rust-side build tooling initializes an HTTP client during `vp build`; without an explicit CA bundle, sandboxed
Nix builds can inherit `/no-cert-file.crt` and abort before the web bundle is produced.

## Hash refresh workflow

When either lockfile changes, the fixed-output `pnpmDeps` hashes in `flake.nix` can drift. The lockfile
workflow above refreshes them automatically. To refresh them directly, use:

- `vp run --workspace-root deps:nix-refresh`

The command builds the web, server, and runtime dependency stores concurrently with `lib.fakeHash`, rewrites
their defaults in `flake.nix`, and verifies `projectReleaseGate`. `just qa-nix-deps` is its non-mutating check.

## Development state

The web process always passes an explicit private `--home-dir`, preserving the existing managed
`<state>/t3-home` path. It must never inherit the production `T3CODE_HOME`. Web and Metro keep separate
cache directories and share native dependency preparation. Setup uses `CI=true` so pnpm can repair stale
node_modules without an interactive prompt. Production keeps its independent flake build and
`wait-for-idle` pre-deploy action; migrating development must not force restart an active T3 server.

Native setup owns dependency installation. Metro starts the installed Expo binary
directly so pnpm does not attempt a second install when entering a managed
workspace. The local `.pnpm-store` cache is ignored and excluded from source
snapshots.
Metro listens on the private workspace network so the preview proxy can reach it.
Its cold-start readiness allowance is 300 seconds.

## Service behavior

The NixOS module runs `t3 serve` as a dedicated system user. By default it binds to `127.0.0.1:3773`, stores
state under `/var/lib/t3code`, and uses `/var/lib/t3code/projects/default` as the default provider working
directory. Deployments that should be reachable beyond localhost must set `services.t3code.host`, and usually
`services.t3code.openFirewall`.

Some deployments already have a user, home directory, and agent credentials managed by their host
configuration. Those hosts can set `services.t3code.createUser = false`, `createBaseDir = false`, or
`createCwd = false` and provide their own user, tmpfiles, and environment values such as `HOME` or
`CODEX_HOME`. The default remains self-contained so new installs do not need host-specific user management.

Provider CLIs such as Codex, Claude, Cursor, or OpenCode are intentionally not bundled into the package. Add
them through `services.t3code.providerPackages` or configure absolute binary paths in T3 Code settings.

## Offline license notices

The Nix web build runs upstream's third-party license generation. Its SPDX templates come from a
pinned fixed-output source in `nix/spdx.nix`, because sandboxed builds cannot fetch them on demand.
Package overrides supply verified MIT notices that the fastdom, strictdom and khroma npm packages
omit. Remove those overrides when the published packages contain usable notices.
