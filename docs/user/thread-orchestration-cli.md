# Thread orchestration from the CLI

The `t3 thread` command lets a person or an agent inspect and control durable
T3 Code threads. It talks to the running T3 Code server for the selected data
directory, so start the server before using it.

Run `t3 thread --help` for the full command reference. Every command accepts
`--json` for compact machine-readable output.

```bash
t3 thread projects --json
t3 thread models --json
t3 thread models --include-legacy --json
t3 thread list --json
t3 thread read <thread-id> --json
t3 thread result <thread-id> --json
t3 thread await <thread-id> --until idle --json
t3 thread graph <thread-id> --json
t3 thread effort create "Parser review" --json
t3 thread create "Implement the parser" --effort <effort-id> --label implementation --worktree --json
t3 thread create "Try a safer implementation" --effort <effort-id> --replaces <thread-id> --worktree --json
t3 thread effort add <effort-id> <thread-id> reviewer --json
t3 thread effort read <effort-id> --json
t3 thread effort list --include-closed --json
t3 thread wait create --effort <effort-id> --mode all --deadline-ms 1800000 --json
t3 thread wait read <wait-id> --json
t3 thread wait list --include-resolved --json
t3 thread wait cancel <wait-id> --json
t3 thread stop <thread-id> --json
t3 thread batch create "Review the parser" \
  --worker 'codex=codexAgent/gpt-5.6-sol?effort:high' \
  --worker 'claude=claudeAgent/claude-opus-5?effort:high' \
  --worktree --timeout-ms 1800000 --json
t3 thread batch read <batch-id> --json
t3 thread batch await <batch-id> --json
t3 thread batch cancel <batch-id> --json
t3 thread batch cleanup <batch-id> --json
t3 thread create "Review the parser" --worktree --json
t3 thread fork --worktree --json
t3 thread send <thread-id> "Please run the focused tests" --json
t3 thread send <thread-id> "After that, update the docs" --queue --json
t3 thread rename <thread-id> "Parser review" --json
```

`send` delivers the message immediately. It starts an idle thread or steers a running turn. Add
`--queue` when the message should wait behind active work. Corrections and review findings that
affect the current implementation should normally be sent immediately.

Provider sessions set `T3CODE_THREAD_ID`, which lets `create`, `read`, `send`,
and `rename` record the calling thread automatically. When running the CLI from
an unrelated shell, pass `--from-thread <thread-id>` if the command needs caller
identity. `create` requires caller identity because it inherits the caller's
project, provider, model, runtime mode, and interaction mode unless those
choices are overridden.

For `create --worktree`, T3 Code generates one concise title and uses it for both the thread and
worktree name. An explicit title remains authoritative. If automatic naming is unavailable, the
worktree receives a short `task-…` name rather than a truncated copy of the prompt.

Model discovery lists current models by default. Pass `--include-legacy` to inspect models that
the provider manifest marks as legacy. Thread creation, batch creation, and model-changing sends
reject legacy selections, including a model inherited from the calling thread. Use
`--allow-legacy-model` only for an intentional compatibility or model-evaluation run. Existing
threads can continue using their selected model without that flag.

## Efforts and waits

An effort is an optional label and membership record around ordinary threads. It does not replace
them: every member still opens, chats, runs tools, shows files, and owns artifacts exactly like any
other thread. A coordinator with one open effort automatically adds newly created children to it.
Use `create --no-effort` to opt out, or `create --effort <effort-id>` when more than one effort is
open. `--replaces <thread-id>` records worker replacement and moves membership within the effort.

A wait is a separate durable barrier. `wait create` registers it and returns immediately, so it is
not limited by the lifetime of a CLI process or provider tool call. The server wakes the coordinator
when all or any selected members settle, when a worker needs approval or input, or when the deadline
passes. Open waits are resumed after a server restart. `wait cancel` cancels only the barrier;
`stop` interrupts a worker, and `effort close --stop-members` closes the group and interrupts its
local members.

Create a wait from one source: either `--effort <effort-id>` or `--members <id,id,...>`. The first
production version keeps waits on one host so completion events remain reliable. Relationships can
already describe remote children, while cross-host wait monitoring and stopping fail explicitly.

Efforts are neutral. Workers may cooperate, specialize, review one another, or compete. Comparison
is a UI action over selected threads, not a required property of the effort.

## Durable batches

`t3 thread batch create` remains convenience syntax for launching one or more workers with the same
prompt. Each `--worker` uses
`label=provider-instance/model?option:value`; repeat the flag to compare models,
providers, or reasoning settings. The server assigns an opaque batch id, stores
the exact membership on the coordinator thread, and keeps monitoring after the
CLI command or coordinator turn exits.

The barrier settles when every worker completes, fails, or is interrupted. A
worker blocked on approval or user input keeps the barrier open and queues an
attention message on the coordinator; resolving the request lets the same
batch continue. A deadline settles the barrier and interrupts live local
workers. Once settled, the server queues one result message on the coordinator
thread so it can compare the results without holding a tool call open. Barrier
state is reconstructed from durable activities after a server restart.

Worker summaries expose normalized outcomes (`queued`, `running`, `completed`,
`failed`, `interrupted`, `blocked-approval`, or `blocked-input`) alongside the
provider's raw status and latest assistant response. Existing batches also appear in the UI through
a compatibility effort and wait; their persisted batch semantics do not change.

Cancellation and workspace cleanup are intentionally separate. `cancel`
interrupts live local workers but preserves their partial work. `cleanup`
deletes managed local workspaces only after the batch is terminal. A worktree
isolates working state; it is not a security boundary and does not prevent a
full-access worker from reading sibling paths. Sandboxed blind evaluations need
a container, microVM, or another restricted runtime.

Batch membership and graph lineage support workers on registered remote hosts.
Cross-host cancel and cleanup currently fail explicitly before changing any
member; they do not silently report success while remote workers keep running.

Use `--environment <environment-id>` with the id returned by
`t3 thread projects` to target a registered remote host. Register hosts with
`t3 remote register`. Remote thread creation also needs
`--project <project-id>` because projects are local to each host.

`fork` currently targets the local host. Codex-backed sources use Codex App
Server transcript cloning. Other providers create a related thread without
copied transcript history.
