# Nix flake packaging

## Purpose

This fork ships a root `flake.nix` so the server can be built and deployed with Nix.
The flake exposes:

- `packages.default`: a packaged `t3` server with the bundled web client and production dependencies.
- `apps.t3`: a runnable `t3` app entrypoint. The flake intentionally has no default app.
- `packages.projectRuntime` and the `prepare`, `dev`, and `dev-mobile` apps: the repository-owned mobile
  Development adapter, with lifecycle and allocation supplied by the pinned public Project Runtime.
- `devShells.default`: Node 24, pnpm 11.10, JJ, Git, SSH, and native build tooling.
- `nixosModules.default`: a `services.t3code` systemd service module for NixOS hosts.

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

`pnpm-deploy-lock.yaml` is generated, not hand-edited. After changing a workspace manifest or the canonical
lockfile, run `nix develop -c node scripts/sync-pnpm-deploy-lock.mjs`, review both lockfiles, and commit them
together. CI or a local gate can append `--check`; it regenerates the deploy lock in memory and fails when the
committed copy has drifted. The script requires the flake's pinned pnpm 11.10 and restores the canonical
lockfile and workspace file even when pnpm fails.

The three derivations deliberately have separate source filters. Web-only edits do not invalidate the server
bundle or runtime dependencies; server-only edits do not invalidate the web bundle; documentation changes do
not invalidate dependency fetches. Lockfile and manifest changes remain shared inputs because they can change
any dependency graph.

Production Nix builds disable web and server source maps. Local and development builds retain source maps by
default; set `T3CODE_WEB_SOURCEMAP=false` or `T3CODE_SERVER_SOURCEMAP=false` to reproduce the production mode.
Production configs use Vite without importing the test configuration. Vitest has dedicated config files, so
the test resolver plugin is not loaded during production bundling.

The flake pins pnpm 11.10 and uses fetcher version 4 with `trustLockfile`. This avoids re-resolving and
re-verifying an already frozen lockfile while retaining Nix's fixed-output dependency hash as the integrity
boundary.

The build environment sets `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS` to nixpkgs' `cacert` bundle. Vite+'s
Rust-side build tooling initializes an HTTP client during `vp build`; without an explicit CA bundle, sandboxed
Nix builds can inherit `/no-cert-file.crt` and abort before the web bundle is produced.

## Hash refresh workflow

When either lockfile changes, the fixed-output `pnpmDeps` hashes in `flake.nix` can drift. First synchronize
the deploy lock as described above, then use:

- `just prefetch-pnpm-deps`

The helper intentionally runs the derivation with `lib.fakeHash`, then prints the new `sha256-...` value from
the Nix error output so the hash refresh stays reproducible and copy/paste-free.

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
