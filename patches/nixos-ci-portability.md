# NixOS CI portability

Kiln runs the fork's checks on NixOS aarch64 workers. Upstream's CI runs on Ubuntu and macOS, so a few
upstream tests and one wrapper script assume an FHS system: tools under `/bin` and `/usr/bin`, a coreutils
that is a set of separate programs, dash as `/bin/sh`, x86-64 or Apple silicon, and English tool messages.

## What the fork changes

- `flake.nix` (`devShells.ci`): `LC_ALL=C.UTF-8`, because the workers inherit the host's German locale and
  tests match English Git messages. It also adds `jujutsu` for the jj workspace tests.
- `apps/server/src/provider/acp/AcpSessionRuntime.ts`: the cgroup wrapper checks that the target command
  resolves before `exec`. bash as `/bin/sh` exits 127 from a failed `exec` without running the EXIT trap,
  so a missing target reported 127 instead of the wrapper's 125.
- `apps/desktop/src/wsl/DesktopWslEnvironment.test.ts`: the busy-runtime holder renames a shell instead of
  `cat`. A multi-call coreutils picks its program from argv[0].
- `apps/server/src/provider/acp/AcpClientTerminals.test.ts`: the Devin shell test passes PATH in the session
  environment, which replaces the inherited one.
- `apps/server/src/provider/OpenCodeServerLedger.test.ts`: Linux runs the macOS `ps` path only where
  `/bin/ps` exists.
- `apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts`: the registry fixture also lists
  `linux-aarch64`.

## Removing it

Each change is a portability fix upstream can take as is. Drop the matching line here once upstream has an
equivalent. The locale and `jujutsu` lines stay as long as Kiln runs the checks.
