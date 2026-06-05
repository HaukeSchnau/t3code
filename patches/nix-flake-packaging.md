# Nix flake packaging

## Purpose

This fork ships a root `flake.nix` so the server can be built and deployed with Nix.
The flake exposes:

- `packages.default`: a packaged `t3` server with the bundled web client and production dependencies.
- `apps.default`: a runnable `t3` app entrypoint.
- `devShells.default`: Node 24, pnpm 10, JJ, Git, SSH, and native build tooling.
- `nixosModules.default`: a `services.t3code` systemd service module for NixOS hosts.

## Packaging behavior

The package follows the existing server publish flow:

1. Build `@t3tools/web`.
2. Run the server package `build` script, which bundles `apps/server/dist/bin.mjs` and copies the web
   bundle into `apps/server/dist/client`.
3. Create a minimal runtime workspace containing only `apps/server`, the lockfile, workspace settings, patch
   files, and the built `dist`.
4. Run `pnpm install --prod --frozen-lockfile --filter t3 --ignore-scripts` offline in that runtime workspace.
5. Wrap the resulting CLI with Node and common runtime tools on `PATH`.

The minimal runtime workspace avoids pulling unrelated packages such as `infra/relay` into the deployable
server closure. The `--ignore-scripts` install flag avoids rerunning the root `prepare` patch script during
the install phase; native packages used by the server are already present in the fixed pnpm dependency store.

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
