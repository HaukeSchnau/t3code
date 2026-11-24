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
(`t3_thread_launch`, `delegate_task`) and scheduled tasks. A repository thread goes only to a
machine that already has a project for that repository. Upstream only balances in the browser, and
never waits for room.

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
  1.4 GiB and 20 come from the srv-2 incident above. The browser's Auto balance
  (`client-runtime/src/load-balancing.ts`) uses the same slots until the clients switch to the
  server's placement.
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
  project of the same `repositoryIdentity.canonicalKey`, and scratch goes anywhere. Peers are asked
  for their matching project with the report request (`match`), cached for a minute. A thread with
  attachments, composer context, an existing worktree or a local base commit stays here, and its
  placement says why. Launches this environment sent count against their machine for 20 seconds.
  A retried launch reuses its first decision for 10 minutes. That decision lives in memory, so a
  retry after a restart can pick another machine and start the thread twice.
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
  stores who decided, where, why, every candidate's score and note, and the wait. Clients do not
  show it yet.

## Limits

- A delegated task never waits for room: placed here it starts as a local task, placed on a peer
  it starts at once there without a placement record, since remote delegation forwards through
  `/mcp`, which cannot carry the stamp. Its parent is already running and waits on it.
- A delegated task placed on a peer works in that machine's checkout, without the parent's
  uncommitted edits, as an explicit remote delegation does. One that names a `driverKind` stays
  here, since remote delegation runs a provider instance and does not check its driver kind.
- A scheduled task bound to a thread (continue or fresh session) runs where its thread is.

## Removal

Remove the pressure signal when upstream scores machines by memory pressure or agent headroom, and
the placement setting when upstream stores placement on each environment. Remove the placement
service when upstream places new threads across connected environments on the server.

## Verification

`HostPressure.test.ts`, shared `placement.test.ts`, the load balancing cases in client-runtime
`projectGrouping.test.ts`, the placement case in shared `serverSettings.test.ts`, and the waiting
case in `ThreadLaunchService.test.ts`.
