# Thread orchestration from the CLI

The `t3 thread` command lets a person or an agent inspect and control durable
T3 Code threads. It talks to the running T3 Code server for the selected data
directory, so start the server before using it.

Run `t3 thread --help` for the full command reference. Every command accepts
`--json` for compact machine-readable output.

For managed worker threads, prefer one lifecycle:

```bash
t3 thread create "Review the parser" --worktree --json
t3 thread wait create --members <thread-id> --mode all --json
```

Create or fork the workers, register one durable wait covering them, then let the coordinator turn
end. The server wakes the coordinator when the workers settle or need attention. Use `send` for
direct coordination between threads. Use `watch create` for external commands and WebSocket events,
not for thread completion. Use `result`, `batch read`, or `wait read` for a one-time status check.

When one agent delegates to another, its prompt should keep the user's words separate from the
coordinator's interpretation:

```text
Source request
<relevant user request, verbatim>

Coordinator context
<earlier context, interpretation, and useful constraints>
```

Describe the result and verification that matter. Keep genuine ownership and safety boundaries
strict, but leave the approach to the worker unless the user already chose it.

The examples below cover the broader command set:

```bash
t3 thread projects --json
t3 thread models --json
t3 thread models --include-legacy --json
t3 thread list --json
t3 thread read <thread-id> --json
t3 thread result <thread-id> --json
t3 thread graph <thread-id> --json
t3 thread effort create "Parser review" --json
t3 thread create "Implement the parser" --effort <effort-id> --label implementation --worktree --json
t3 thread create "Try a safer implementation" --effort <effort-id> --replaces <thread-id> --worktree --json
t3 thread effort add <effort-id> <thread-id> reviewer --json
t3 thread effort read <effort-id> --json
t3 thread effort list --include-closed --json
t3 thread wait create --effort <effort-id> --mode all --deadline-ms 1800000 --json
t3 thread wait create --effort <effort-id> --mode all --summarize --json
t3 thread wait read <wait-id> --json
t3 thread wait list --include-resolved --json
t3 thread wait cancel <wait-id> --json
t3 thread watch create --command 'deployctl logs --follow' --json
t3 thread watch create --argv-json '["deployctl","logs","--follow"]' \
  --instruction 'Wake when the production deployment either succeeds or fails' --json
t3 thread watch create --websocket wss://deploy.example/events --deadline-ms 3600000 --json
t3 thread watch read <watch-id> --json
t3 thread watch list --include-closed --json
t3 thread watch cancel <watch-id> --json
t3 thread stop <thread-id> --json
t3 thread batch create "Review the parser" \
  --worker 'codex=codexAgent/gpt-5.6-sol?effort:high' \
  --worker 'claude=claudeAgent/claude-opus-5?effort:high' \
  --worktree --timeout-ms 1800000 --json
t3 thread batch read <batch-id> --json
t3 thread batch cancel <batch-id> --json
t3 thread batch cleanup <batch-id> --json
t3 thread create "Review the parser" --worktree --json
t3 thread fork <source-thread-id> --effort <effort-id> --label prototype --worktree --json
t3 thread send <thread-id> "Please run the focused tests" --json
t3 thread send <thread-id> "After that, update the docs" --queue --json
t3 thread rename <thread-id> "Parser review" --json
```

`send` delivers the message immediately. It starts an idle thread or steers a running turn. Add
`--queue` when the message should wait behind active work. Corrections and review findings that
affect the current implementation should normally be sent immediately.

Provider sessions set `T3CODE_THREAD_ID`, which lets `create`, `fork`, `read`, `send`,
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
Forks use the same effort inheritance rule. Pass `fork --effort <effort-id> --label <label>` to
create the fork with its membership in one operation, or `fork --no-effort` to opt out. The caller
owns the new thread while the selected source remains its separate fork origin. When the caller
forks itself, both facts point to the caller.

A wait is a separate durable barrier. `wait create` registers it and returns immediately, so it is
not limited by the lifetime of a CLI process or provider tool call. The server wakes the coordinator
when all or any selected members settle, when a worker needs approval or input, or when the deadline
passes. Open waits are resumed after a server restart. `wait cancel` cancels only the barrier;
`stop` interrupts a worker, and `effort close --stop-members` closes the group and interrupts its
local members.

Add `--summarize` to have the configured system text-generation model summarize a resolved wait,
including failures, disagreements, and a recommended next step. `--summary-instruction` adds
context for that summary. Settlement remains deterministic: generation runs only after the barrier
has resolved, and a model failure falls back to the ordinary raw result notification.

Create a wait from one source: either `--effort <effort-id>` or `--members <id,id,...>`. The first
production version keeps waits on one host so completion events remain reliable. Relationships can
already describe remote children, while cross-host wait monitoring and stopping fail explicitly.

Efforts are neutral. Workers may cooperate, specialize, review one another, or compete. Comparison
is a UI action over selected threads, not a required property of the effort.

## Durable watches

A watch keeps observing after the creating agent turn and CLI process have finished. It accepts
exactly one source: a shell command, an argument array, or a WebSocket endpoint. Each stdout line
from a command and each text frame from a WebSocket is an event. Command stderr is drained but is
not delivered as an event. A command watch completes when its process exits; a WebSocket watch
reconnects after transient connection failures. An optional deadline closes either kind.

Watch definitions are persisted. After the T3 Code server restarts, every open source starts a new
execution generation. Notifications carry the watch id, generation, and sequence so stale output
cannot be mistaken for current output. Archiving or deleting the coordinator cancels its watches;
stopping one provider turn does not.

Without `--instruction`, every accepted event batch queues a wake-up. With an instruction, the
configured system text-generation model decides whether to ignore the batch, wake the agent, or
wake it and close the watch. This defaults to GPT-5.6 Luna in a standard installation. If model
evaluation fails, the raw batch is queued so an infrastructure problem cannot silently hide the
event. Event text is bounded and paced before generation or delivery to prevent a noisy source from
flooding the thread.

Watch and wait notifications appear as typed activity cards in thread history. They are queued in
FIFO order behind active work and automatically start the next turn when the thread is idle. The
Work panel lists open watches and their observed event counts. Use `watch cancel` as the explicit
way to stop one without archiving the thread.

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
