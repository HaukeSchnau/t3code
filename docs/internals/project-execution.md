# Project execution

The optional managed execution launcher is an environment capability. Project creation requests it through `ProjectCreateCommand.separateEnvironment`; the normalizer captures a deferred preparation effect so filesystem creation follows the existing dispatch workflow.

The infra launcher owns persistent project registration and private runtime state. `SeparateProjectRegistry` reads the versioned path registry without loading provider history or project source. `ProjectExecution` resolves the registered cwd before process spawning, preserving ordinary command performance and rejecting a missing launcher for registered paths.

The provider spawner wraps commands before applying systemd scopes. Claude's synchronous SDK spawn callback is supplied only after resolving separate execution. TerminalManager resolves the launcher before PTY creation, so project setup scripts inherit the same behavior. ProcessRunner also resolves execution for commands with a cwd.

The server stays outside the filesystem environment. Provider traffic continues over stdio, MCP remains reachable over the existing HTTP endpoint, and app previews use host routing. Host services requested through the infra bridge must re-enter the project environment when launching project code.

The registry root is a stable project identity. Settings cannot move it implicitly, and managed workspace creation is currently rejected. These restrictions can be replaced with an explicit migration/alias protocol once multi-workspace execution is implemented.
