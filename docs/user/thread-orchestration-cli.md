# Thread orchestration from the CLI

The `t3 thread` command lets a person or an agent inspect and control durable
T3 Code threads. It talks to the running T3 Code server for the selected data
directory, so start the server before using it.

Run `t3 thread --help` for the full command reference. Every command accepts
`--json` for compact machine-readable output.

```bash
t3 thread projects --json
t3 thread models --json
t3 thread list --json
t3 thread read <thread-id> --json
t3 thread result <thread-id> --json
t3 thread await <thread-id> --until idle --json
t3 thread graph <thread-id> --json
t3 thread create "Review the parser" --worktree --json
t3 thread fork --worktree --json
t3 thread send <thread-id> "Please run the focused tests" --json
t3 thread rename <thread-id> "Parser review" --json
```

Provider sessions set `T3CODE_THREAD_ID`, which lets `create`, `read`, `send`,
and `rename` record the calling thread automatically. When running the CLI from
an unrelated shell, pass `--from-thread <thread-id>` if the command needs caller
identity. `create` requires caller identity because it inherits the caller's
project, provider, model, runtime mode, and interaction mode unless those
choices are overridden.

Use `--environment <environment-id>` with the id returned by
`t3 thread projects` to target a registered remote host. Register hosts with
`t3 remote register`. Remote thread creation also needs
`--project <project-id>` because projects are local to each host.

`fork` currently targets the local host. Codex-backed sources use Codex App
Server transcript cloning. Other providers create a related thread without
copied transcript history.
