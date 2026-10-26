# NixOS CI portability

Calder runs the fork's checks on loaded NixOS aarch64 workers. Upstream's CI runs on Ubuntu and macOS, so a few
upstream tests and one wrapper script assume an FHS system: tools under `/bin` and `/usr/bin`, a coreutils
that is a set of separate programs, dash as `/bin/sh`, x86-64 or Apple silicon, and English tool messages.

## What the fork changes

- `flake.nix` (`devShells.ci`): `LC_ALL=C.UTF-8`, because the workers inherit the host's German locale and
  tests match English Git messages. It also adds `jujutsu` for the jj workspace tests, and on Linux points
  `T3CODE_BROWSER_TEST_CHROMIUM` at nixpkgs' Chromium for the web browser tests, because the Chromium
  Playwright downloads does not run on NixOS.
- `apps/desktop/src/wsl/DesktopWslEnvironment.test.ts`: the busy-runtime holder renames a shell instead of
  `cat`. A multi-call coreutils picks its program from argv[0].
- `packages/provider-acp/src/server/clientTerminals.test.ts`: the Devin shell test passes PATH in the session
  environment, which replaces the inherited one.
- `packages/provider-opencode/src/server/OpenCodeServerLedger.test.ts`: Linux runs the macOS `ps` path only
  where `/bin/ps` exists.
- `apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts`: the registry fixture also lists
  `linux-aarch64`.
- `apps/server/src/preview/ServerBrowserPage.test.ts`: the tests launch `T3CODE_BROWSER_TEST_CHROMIUM` when
  it is set. `packages/shared/src/testing/providerEnv.ts` keeps that variable on its `KEPT_ENV` list,
  because the test reads it after setup has scrubbed every other `T3CODE_*` variable.
- `apps/server/src/vcs/VcsProcess.ts`: Git subprocesses run with `LC_ALL=C`. Lock errors combine
  translated Git and libc messages, and transient-exit classification matches the English text.
- `apps/server/src/entrypoint.ts`: `isEntrypoint` resolves both the module path and `argv[1]`, because
  sandboxed runners can expose one directory through two mount aliases.
- `scripts/notify-discord-release.test.ts`: the shells that run the release workflow's Discord steps get
  PATH. Their environment replaces the inherited one, and without PATH Node looks for `bash` only in `/bin`
  and `/usr/bin`.
- `.github/scripts/relay-state-output.test.cjs` and `vercel-deployment-output.test.cjs`: the shells that run
  workflow steps start with `--noprofile --norc`. Node connects a child's stdio through sockets, so NixOS's
  bash takes itself for an SSH session, sources `/etc/bashrc` and resets PATH to the system profile, which
  lacks the CI shell's `jq`.
- `apps/web/test/browserWaitFor.ts` (a browser-project setup file): `vi.waitFor` waits five seconds by
  default instead of one. Calder's aarch64 workers take longer than that to parse and lay out heavy file
  previews (a 2,000-output notebook, ODS, RTF, fonts), and Vitest has no setting for the default.

## Removing it

Each change is a portability fix upstream can take as is. Drop the matching line here once upstream has an
equivalent. The locale and `jujutsu` lines stay as long as Calder runs the checks.
