# Fleet placement

## Requirement

Auto balance must not send a new thread to a machine that is about to kill agents for memory, and
every device must see one placement choice per machine. On 2026-11-16 srv-2 ran about 15 agents,
its agents slice held 8 GB of RAM and 13 GB of swap, PSI memory `some` sat at 65 to 92, and
systemd-oomd killed whole agents. `MemAvailable` still looked fine, and the machine only looked
full once CPU passed 95%. Upstream scores machines from CPU and `MemAvailable` alone and keeps the
on/off switch and per-machine weights in each browser's client settings, so web, desktop and phone
disagree. This is phase 1 of fleet worlds (schnau/t3code#186, #189).

## Design

- `HostResourcesSnapshot` (`packages/contracts/src/resourceTelemetry.ts`) gains optional fields,
  absent where the host cannot report them: PSI memory `some` avg10 and avg60, swap free and total,
  the macOS `kern.memorystatus_vm_pressure_level`, and the `app-t3code-agents.slice` cgroup's
  `memory.current`, `memory.max` and running agent scopes. `HostResources.ts` reads them through
  the parsers in `apps/server/src/resourceTelemetry/HostPressure.ts`, and finds the slice's cgroup
  with `systemctl --user show`. Terminal, watch and preview-browser scopes are not agents.
- `chooseLoadBalancedEnvironment` (`packages/client-runtime/src/load-balancing.ts`) scores
  weight × free agent slots. Slots are the smaller of idle cores and the memory left (the lesser of
  `MemAvailable` and the slice's headroom) divided by the larger of 1.4 GiB and the running agents'
  average. A machine at PSI 20 or a macOS level above normal gets no work, and pressure below that
  scales its score down linearly. The 1.4 GiB and 20 come from the srv-2 incident above.
- Each server stores `placementWeight` in its settings: null until set, 0 for Manual only, and
  25, 50 or 100 to take balanced work. The web settings section writes it per machine, and the
  composer reads each machine's live value (`usePlacementWeights`). The web client migrates a
  browser whose upstream switch was on once per machine, with `migratePlacementWeight`, which the
  server applies only while `placementWeight` is still null (`placementMigrationPatch`, run beside
  the model preference migration in `useSettings.ts`). Upstream's `loadBalancingEnabled` and
  `loadBalancingWeights` client settings stay in the schema so old values still decode, and
  nothing reads them except the migration.

## Removal

Remove the pressure signal when upstream scores machines by memory pressure or agent headroom, and
the placement setting when upstream stores placement on each environment. Phase 2 (#190) moves the
choice itself to a server-side placement service.

## Verification

`HostPressure.test.ts`, the load balancing cases in client-runtime `projectGrouping.test.ts`, and
the placement case in shared `serverSettings.test.ts`.
