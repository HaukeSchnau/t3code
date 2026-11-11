# Remote device tunnel lifetime

T3 supervises the `ssh` process that forwards a device host's ports, so that process must stay in
the foreground for the tunnel's whole life. Upstream now disables connection sharing for the tunnel
(`ControlMaster=no`, `ControlPath=none`, `ControlPersist=no`) and ties it to a remote `cat` on
stdin. The fork adds `ForkAfterAuthentication=no` in `device/SshDeviceHost.ts`, because a user
config that forks after authentication detaches ssh from the supervised process the same way.
Bootstrap commands keep the user's SSH configuration.

Uploads and concurrent device commands can delay HTTP health responses past the five-second
deadline. A deadline alone must not replace the tunnel and its local ports, since active clients
still use those ports. Upstream now reconnects only after three consecutive missed probes, but
still counts a timeout as a miss, so an upload over a slow link that holds the helper for 30 seconds
drops the forward. It also allows 15 seconds for initial readiness. The fork:

- allows 60 seconds with five-second probes for initial readiness, for slow SSH authentication and
  network links;
- treats a timed-out health probe as inconclusive (`deviceHealthProbe`), so only definite failures
  count toward upstream's `UNHEALTHY_PROBE_LIMIT` (`waitForUnhealthyDeviceHost`). Upstream's
  reconnect test fakes a hub that is down with a 503 for that reason.

An SSH process exit still triggers immediate reconnection, and SSH keepalives handle lost transport
connections. This does not detect a helper that accepts connections but hangs indefinitely. Such a
host can be reconnected explicitly.

The device quick start (`agentDeviceQuickStart` in `mcp/toolkits/device/handlers.ts`) tells agents
that `install` uploads a local `.app` or `.apk` to a remote host, that `remote:/absolute/path` reuses
an artifact already there, and that Metro reachability is theirs to arrange. Remove that line when
upstream's quick start covers remote installs.

Remove `ForkAfterAuthentication=no` when upstream sets it. Remove the health changes when upstream
stops counting a timed-out probe as a miss.
