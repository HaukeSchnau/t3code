# NixOS CI portability

Calder runs the fork's checks on loaded NixOS aarch64 workers. Upstream's CI runs on Ubuntu and macOS, so a few
upstream tests and one wrapper script assume an FHS system: tools under `/bin` and `/usr/bin`, a coreutils
that is a set of separate programs, dash as `/bin/sh`, x86-64 or Apple silicon, and English tool messages.

## What the fork changes

- `flake.nix` (`devShells.ci`): `LC_ALL=C.UTF-8`, because the workers inherit the host's German locale and
  tests match English Git messages. It also adds `jujutsu` for the jj workspace tests, and on Linux points
  `T3CODE_BROWSER_TEST_CHROMIUM` at the `nixpkgs-node` build of Playwright's Chromium headless shell for the
  web browser tests, because the browsers Playwright downloads do not run on NixOS. It is the same browser
  upstream tests with; full Chromium differs, for example in `:hover` over an iframe. Keep that input's
  `playwright-driver` version equal to the workspace's `playwright`.
  `devShells.ci-desktop` runs the Linux desktop launch check. npm's Electron is linked for FHS
  distributions, so its `desktop-fhs` command runs the packaging and the launch in a `buildFHSEnv` with
  nixpkgs' AppImage libraries, and `xvfb-run` gives the app a display. That environment's glibc is
  newer than upstream's Ubuntu 24.04 build ceiling (2.39), and node-pty compiles against it, so the
  step sets `T3CODE_DESKTOP_GLIBC_WITHOUT_CEILING=1` and `scripts/linux-glibc.ts` skips the ceiling
  while still reading every ELF file. The fork ships no Linux desktop build: the app goes only to macOS
  (see `desktop-distribution.md`), and Linux hosts run the Nix-built server. The override can go if the
  FHS environment's glibc drops to the ceiling or the fork starts shipping Linux desktop builds, which
  would then need native modules built against an older glibc.
  `apps/web/vitest.config.ts` pins that browser's locale to `en-US`, because the headless shell follows the
  host's German `LANGUAGE`, and tests match English number formats.
- `apps/desktop/src/wsl/DesktopWslEnvironment.test.ts`: the busy-runtime holder renames a shell instead of
  `cat`. A multi-call coreutils picks its program from argv[0].
- `packages/provider-acp/src/server/clientTerminals.test.ts`: the Devin shell test passes PATH in the session
  environment, which replaces the inherited one.
- `packages/provider-opencode/src/server/OpenCodeServerLedger.test.ts` and
  `apps/server/src/cloud/RelayClientLedger.test.ts`: Linux runs the macOS `ps` path only
  where `/bin/ps` exists.
- `apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts`: the registry fixture also lists
  `linux-aarch64`.
- `apps/server/src/preview/ServerBrowserPage.test.ts`, `ServerBrowser.test.ts`, `ServerBrowserContexts.test.ts`
  and `apps/web/scripts/verify-built-boot.ts`: every Chromium they launch is `T3CODE_BROWSER_TEST_CHROMIUM` when it
  is set. `packages/shared/src/testing/providerEnv.ts` keeps that variable on its `KEPT_ENV` list,
  because the server test reads it after setup has scrubbed every other `T3CODE_*` variable.
- `apps/server/src/vcs/VcsProcess.ts`: Git subprocesses run with `LC_ALL=C`. Lock errors combine
  translated Git and libc messages, and transient-exit classification matches the English text.
- `apps/server/src/entrypoint.ts`: `isEntrypoint` resolves both the module path and `argv[1]`, because
  sandboxed runners can expose one directory through two mount aliases.
- `apps/server/src/project/AgentSessionScanner.ts`: the scanner resolves the real paths of `baseDir` and
  `worktreesDir` for the same reason, so a T3 home reached through an alias still matches the
  session paths it filters out.
- `scripts/notify-discord-release.test.ts`: the shells that run the release workflow's Discord steps get
  PATH. Their environment replaces the inherited one, and without PATH Node looks for `bash` only in `/bin`
  and `/usr/bin`.
- `scripts/install.test.ts`: the `install.sh t3 command` case runs the installer with a folder of links to
  the host's programs instead of `/usr/bin:/bin`, leaving out any `t3`, since srv hosts have T3 Code on
  PATH. Its no-SHELL run sets SHELL empty, because bash as `/bin/sh` fills in an unset SHELL.
- `apps/server/src/cloud/serviceProtection.test.ts`: the privileged script runs with the test's own PATH
  after `/usr/bin:/bin`, which hold no `mkdir` on NixOS. Its fake `systemctl` still comes first.
- `packages/ssh/src/launcherTestHarness.ts` and `tunnel.test.ts`: the generated SSH launch scripts run with
  a folder of links to the host's programs (`linkHostToolsWithoutT3`) instead of `/usr/bin:/bin` or sh's
  default PATH, and the fake `ps` and the readiness wait call the real `ps` and `sleep` from that folder.
  It leaves out `t3`, because the runner prefers a host `t3`. The login-settings test's Bash wrapper runs
  `bash` from PATH instead of `/bin/bash`. The launch scripts themselves were already portable: they find
  every tool on the login PATH, and their only fixed path is `#!/bin/sh`, which NixOS has.
- `.github/scripts/relay-state-output.test.cjs` and `vercel-deployment-output.test.cjs`: the shells that run
  workflow steps start with `--noprofile --norc`. Node connects a child's stdio through sockets, so NixOS's
  bash takes itself for an SSH session, sources `/etc/bashrc` and resets PATH to the system profile, which
  lacks the CI shell's `jq`.
- `scripts/aur-release.test.ts`: the fake `gh` starts with `#!/usr/bin/env bash` instead of `#!/bin/bash`.
- `apps/server/src/provider/ClaudeCapabilitiesProbe.test.ts`: the fake Bash launcher starts with
  `#!/usr/bin/env bash` instead of `#!/bin/bash`. The probe itself execs the configured Claude path through
  `/usr/bin/env -C`, which NixOS has.
- `apps/server/src/process/NonBlockingSpawner.test.ts`: the absolute-path command is `/bin/sh` instead of
  `/bin/true`, which NixOS does not have.
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts`: the POSIX completion tests run `bash` from
  PATH instead of `/bin/bash`, which NixOS does not have. The runner itself uses the terminal's shell, and
  the terminal manager already falls back to `bash` on PATH.
- `flake.nix` (`T3CODE_BROWSER_TEST_FONTCONFIG` in the CI shell) and `apps/web/vitest.config.ts`: the test
  Chromium gets a fontconfig with DejaVu first, then Noto CJK and emoji. Calder hosts resolve generic
  families differently: srv-2 has DejaVu, while tower and dev-hauke fall back to a CJK monospace with
  half-width Latin. So layout tests such as upstream's numbered-list gutter test passed or failed
  depending on the host. Remove it if upstream's tests stop depending on font metrics.
- `apps/server/src/process/SpawnWorker.test.ts`: the test's child writes its 1 MiB outputs in a loop. A
  single `fs.writeSync` to a non-blocking pipe returns early on Calder's aarch64 worker, so the test saw a
  truncated child instead of testing the worker.
- `apps/web/test/browserWaitFor.ts` (a browser-project setup file): every `vi.waitFor` waits at least 25
  seconds, just under the 30-second browser test timeout, instead of Vitest's one-second default or
  upstream's per-call 10-second limits. Loaded Calder workers took over
  ten seconds to parse and lay out heavy file previews (a 2,000-output notebook, XLSX, ODS, RTF, fonts),
  and Vitest has no setting for the default.
- `apps/web/src/components/pullRequest/PullRequestCodeTab.browser.test.tsx`: the resolved-conversation test
  mounts the tab in a block, as `PullRequestDetailPanel` does. In the flex row the file's other tests use, the
  tab shrinks to its toolbar's 32px padding and the diff's 6px scrollbar covers the avatars the test clicks.
  Upstream's own tree fails the same way in the Linux headless shell, locally and on Calder.

## Removing it

Each change is a portability fix upstream can take as is. Drop the matching line here once upstream has an
equivalent. The locale and `jujutsu` lines stay as long as Calder runs the checks, and `ci-desktop` as
long as Calder's Linux workers run NixOS.
