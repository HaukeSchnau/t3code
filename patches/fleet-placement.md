# Fleet placement

## Requirement

Auto balance must not send a new thread to a machine that is about to kill agents for memory, and
every device must see one placement choice per machine. On 2026-11-16 srv-2 ran about 15 agents,
its agents slice held 8 GB of RAM and 13 GB of swap, PSI memory `some` sat at 65 to 92, and
systemd-oomd killed whole agents. `MemAvailable` still looked fine, and the machine only looked
full once CPU passed 95%. Upstream scores machines from CPU and `MemAvailable` alone and keeps the
on/off switch and per-machine weights in each browser's client settings, so web, desktop and phone
disagree. This is phase 1 of fleet worlds (schnau/t3code#186, #189).

Phase 2 (#190) lets any new thread run on whichever linked machine has room: from clients, agents
(`t3_thread_launch`, `delegate_task`) and scheduled tasks, including machines that do not have the
thread's repository yet. Upstream only balances in the browser, among machines that already have
the project, and never waits for room.

## Design

- `HostResourcesSnapshot` (`packages/contracts/src/resourceTelemetry.ts`) gains optional fields,
  absent where the host cannot report them: PSI memory `some` avg10 and avg60, swap free and total,
  the macOS `kern.memorystatus_vm_pressure_level`, and the `app-t3code-agents.slice` cgroup's
  `memory.current`, `memory.max` and running agent scopes. `HostResources.ts` reads them through
  the parsers in `apps/server/src/resourceTelemetry/HostPressure.ts`, and finds the slice's cgroup
  with `systemctl --user show`. Terminal, watch and preview-browser scopes are not agents.
- `freeAgentSlots` and `decidePlacement` (`packages/shared/src/placement.ts`) score
  weight × free agent slots × warmth. Slots are the smallest of idle cores, the memory left (the
  lesser of `MemAvailable` and the slice's headroom) divided by the larger of 1.4 GiB and the
  running agents' average, and the host's `placementAgentLimit`. Launches in flight and threads
  already waiting count against every bound, so a burst spreads. A machine at PSI 20 or a macOS
  level above normal gets no work, and pressure below that scales its score down linearly. The
  1.4 GiB and 20 come from the srv-2 incident above.
- Each server stores `placementWeight` in its settings: null until set, 0 for Manual only, and
  25, 50 or 100 to take balanced work. The web settings section writes it per machine. The web
  client migrates a browser whose upstream switch was on once per machine, with
  `migratePlacementWeight`, which the server applies only while `placementWeight` is still null.
  Upstream's `loadBalancingEnabled` and `loadBalancingWeights` client settings stay in the schema so
  old values still decode, and nothing reads them except the migration.

### Placement service (phase 2)

- **Load reports.** Every environment answers `POST /mcp/placement/report` (`placement/PlacementHttp.ts`)
  with its `PlacementReport`: host resources, running agents, launches in flight, threads waiting
  for room, served worlds, enabled provider instances, and its weight and agent limit. The route
  admits a request exactly as `/mcp` does (`McpHttpServer.makeRequestAuthenticator`), so a peer
  link's own token reads it. `Placement.start` reads every stored, unexpired link every 5 seconds.
  Reports flow over the link in the direction a launch can go: a machine that can start threads
  on a peer is the one that reads that peer's load.
- **Decision.** `Placement.decide` classifies the thread by its project: a world project needs a
  host that serves that world (worldfs on Linux; m1 serves none), a repository needs a host with a
  project of the same `repositoryIdentity.canonicalKey` or one that may clone it (cold hosts,
  below), and scratch goes anywhere. Peers are asked
  for their matching project with the report request (`match`), cached for a minute. A thread with
  attachments, composer context, an existing worktree or a local base commit stays here, and its
  placement says why. Launches this environment sent count against their machine for 20 seconds.
  A retried launch reuses its first decision for 30 minutes. That decision lives in memory, so a
  retry after a restart can pick another machine and start the thread twice.
- **Cold hosts (decision 2).** A host without the repository is a candidate at half warmth when
  it reports `canClone`. Before the launch, the decider sends `POST /mcp/placement/hydrate` with
  the repository's remote and the source project's git-ignored env files (`.env`, `.env.*`,
  `.envrc`, `.dev.vars`, 1 MiB each). The host clones from the forge into
  `<baseDir>/placement/repos/<repository>`, with `--reference-if-able` to the worlds mirror in
  `/var/lib/worlds/*/catalog.json` when one has the repository, so only refs and the objects the mirror lacks travel. It registers
  the clone as an ordinary project, which later launches find warm. One clone runs at a time.
  - Who may clone: the user's own launches from a session that may write source control (as for
    cloning here), and agents at full access and default interaction (as for `t3_project_clone`),
    over a full-access link with Linked environments on. Before every hydrate
    request the decider checks the link as stored again; for an agent's launch or delegation it
    also rereads the caller's modes, and that its turn is still running. A user's launch checks
    its session once, when it is placed. A host whose
    managed policy caps runtime below full access reports no `canClone`, and neither does a Windows
    host: the env-file guards (mode 0600, path checks) are written for POSIX hosts.
  - Copied files: the host writes only env-file names, with mode 0600, never through a symlink,
    never over an existing file, and never at a path Git tracks in the index or `HEAD`, compared
    without case. It adds the path to the clone's `.git/info/exclude` even when a `.gitignore` covers
    it, as another branch may not, and writes the file only once the clone ignores it, so a secret
    stays out of commits and checkpoints. The file is written whole in the git folder and then
    linked into place, so a full disk leaves no partial copy. Where the link fails (the git folder on
    another filesystem, or no hard links), the file is written in place instead.
  - Slow clones: the host clones in the background and answers "pending" after 20 seconds. The
    sender polls with the request id and no files, retries a lost answer, and gives up after 15
    minutes, so a clone fits within a relay's idle limit. The host keeps each outcome for those
    15 minutes too. A clone still running at the sender's deadline goes on there, and a retry of
    the launch may clone on another linked machine, so both get the env files.
  - Retries: one launch's retries share its single clone and keep its machine for 30 minutes. A
    failed clone keeps that host out of cold placement for that repository for 10 minutes, and
    a retry of that launch decides again. A refusal by the caller or the link does not count as
    a failed clone.
  - Placement requests never follow redirects. A remote's query or fragment is dropped, as the
    repository identity drops it, so the host clones the remote without it.
- **Waiting (decision 1).** When no machine has room, the thread goes to the machine it prefers by
  weight and warmth, behind the fewest waiting threads, with `placement.waitingSince` set.
  `ThreadLaunchService` holds that run's workspace preparation on `LocalPlacement.awaitRoom` until
  the machine has a free slot (checked every 3 seconds, oldest first) or someone calls
  `placement.startNow`. Either ends the wait with `thread.metadata.update { placementWaitEnded }`.
  Stopping the run (the composer's stop, or archiving) cancels the wait.
- **Launching.** Clients call `placement.launch` with the ordinary launch input and open the thread
  it returns on its environment. `t3_thread_launch` accepts `environmentId: "auto"`
  (`McpToolAccess.routed`, `placement/autoLaunch.ts`), and `delegate_task` accepts
  `target.environmentId: "auto"`. Scheduled tasks with `placement: "auto"` start each new thread
  through placement. A launch on a peer goes to its `POST /mcp/placement/launch`, which runs that
  peer's own `t3_thread_launch` handler with the link's credential and stamps the decision through
  `PlacementStamp`, so no tool argument can claim a placement.
- **Thread record.** `thread.placement` (`ThreadPlacement` in `packages/contracts/src/placement.ts`)
  stores who decided, where, why, every candidate's score and note, and the wait.

### Clients

- Web replaces upstream's browser-side Auto balance, including its recheck of machine load before
  a send (`refreshBeforeSend`), because the server decides at send time. An automatic draft stays
  on its machine and shows the server's `placement.preview` ("Auto → dev-hauke"). Its send calls
  `placement.launch` (`startThreadTurn` with `placement: "auto"`), resent after a dropped socket
  like upstream's launch, and `redirectPromotedDraftThread` points the draft at the thread
  wherever it started. A send that is offline or loses its reply waits in the
  durable outbox with `placement: "auto"` and replays the same command, so the server's decision
  and the peer's launch for it are reused while the server keeps that decision (30 minutes, in
  memory); a replay after a restart can start the thread a second time. A follow-up queued during
  the launch goes to the thread wherever it started (`placedDraftThreadRef`). The header's `ThreadPlacementChip` shows where and why with
  every candidate; `placementWaitBannerItem` shows the wait with Start anyway and Cancel (the
  run's stop). Settings → Load balancing edits each machine's weight and agent limit.
- Mobile shows the reason in the thread header and the wait in `PlacementWaitCard`. Starting a
  new task on Auto from the phone is not there yet.

## Limits

- A delegated task never waits for room: placed here it starts as a local task, placed on a peer
  it starts at once there without a placement record, since remote delegation forwards through
  `/mcp`, which cannot carry the stamp. Its parent is already running and waits on it.
- A delegated task placed on a peer works in that machine's checkout, without the parent's
  uncommitted edits, as an explicit remote delegation does. One that names a `driverKind` stays
  here, since remote delegation runs a provider instance and does not check its driver kind.
- A scheduled task bound to a thread (continue or fresh session) runs where its thread is.
- The sender copies env files found among the first 200 git-ignored entries of the project, in
  sorted order, so in a project with many ignored files a nested env file can be missed. An env
  file inside a folder that is ignored as a whole (such as a git-ignored `config/`) is not copied.
- A worktree thread on a clone has no env files, like any new worktree: they sit in the clone's
  checkout, and worktree creation checks out tracked files only.
- A clone made for placement is a normal project, not a hidden one, and nothing evicts it yet.
  A clone that borrows a mirror's objects breaks if the mirror prunes them; infra keeps the
  mirrors with `gc.auto=0`.
- The cloning host needs read access to the forge; the worlds mirror only lends objects.

## Removal

Remove the pressure signal when upstream scores machines by memory pressure or agent headroom, and
the placement setting when upstream stores placement on each environment. Remove the placement
service when upstream places new threads across connected environments on the server.

## Verification

`HostPressure.test.ts`, shared `placement.test.ts`, the load balancing cases in client-runtime
`projectGrouping.test.ts`, the placement case in shared `serverSettings.test.ts`, and the waiting
case in `ThreadLaunchService.test.ts`.
