# Nix-managed provider updates

## Requirement

A provider that T3 Code runs from the Nix store must not offer a one-click update. On our NixOS
servers and nix-darwin Macs, Claude and the other agent CLIs come from `/run/current-system/sw/bin`
or `/etc/profiles/per-user/<user>/bin`, which resolve into `/nix/store`. Nix updates them through
`~/infra`.

## Why upstream does not meet it

Upstream's maintenance resolver knows npm, pnpm, Bun, Yarn, Vite+, Volta, Homebrew, mise and WinGet.
A Nix store path matches none of them, so it falls back to the provider's own updater. `claude
update` then installs a second copy under `~/.local`, exits 0, and the binary T3 runs keeps its old
version. Every update attempt fails with "Update command completed, but T3 Code still detects an
outdated provider version."

## Design

`resolvePackageManagedProviderMaintenance` in
`packages/provider-core/src/server/maintenanceResolver.ts` returns manual-only capabilities when
the real command path is under `/nix/store/`. The version advisory then names the binary and says to
update it with the tool that installed it, and no update action is offered.

## Removal

Remove this when upstream treats Nix store installs as externally managed.

## Verification

`maintenanceResolver.test.ts`: "keeps a Nix store install manual-only".
