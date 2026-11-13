# Host-isolated Claude tests

## Fork requirement

The maintainer's hosts carry Claude Code managed settings (`/etc/claude-code/managed-settings.json`,
from `~/infra`) that set an API endpoint and a key helper for every Claude on the host. T3 Code's
Claude driver reads that file, as Claude Code does, so server tests on those hosts and on the CI
runners saw a real endpoint and a signed-in account where their fixtures set neither.

## Behavior

- `T3CODE_CLAUDE_MANAGED_SETTINGS_DIR` replaces the platform's managed settings directory for the
  settings reader (`ClaudeSkills.ts`).
- The server's test setup (`testUtils/managedServiceEnv.setup.ts`) points it at a missing
  directory, so no test reads the host's managed settings.

## Removal

Remove when upstream lets tests replace the managed settings path, or when no host that runs the
server tests (CI runners and the maintainer's own machines) carries Claude managed settings.
