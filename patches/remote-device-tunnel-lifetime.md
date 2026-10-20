# Remote device tunnel lifetime

T3 supervises the `ssh` process that forwards a device host's ports, so that process must stay in
the foreground for the tunnel's whole life. Upstream now disables connection sharing for the tunnel
(`ControlMaster=no`, `ControlPath=none`, `ControlPersist=no`) and ties it to a remote `cat` on
stdin. The fork adds `ForkAfterAuthentication=no` in `device/SshDeviceHost.ts`, because a user
config that forks after authentication detaches ssh from the supervised process the same way.
Bootstrap commands keep the user's SSH configuration.

Uploads and concurrent device commands can delay HTTP health responses past the five-second
deadline. A deadline alone must not replace the tunnel and its local ports, since active clients
still use those ports. Upstream counts a timeout as a failure and allows 15 seconds for initial
readiness. The fork:

- allows 60 seconds with five-second probes for initial readiness, for slow SSH authentication and
  network links;
- treats a timed-out health probe as inconclusive (`deviceHealthProbe`);
- repairs a helper only after three consecutive definite failures (`waitForUnhealthyDeviceHost`).

An SSH process exit still triggers immediate reconnection, and SSH keepalives handle lost transport
connections. This does not detect a helper that accepts connections but hangs indefinitely. Such a
host can be reconnected explicitly.

The generated agent-device launcher also allows topic help without a selected device. Operational
commands still require explicit config and session.

Remove `ForkAfterAuthentication=no` when upstream sets it. Remove the health changes when upstream
preserves active uploads during health checks, and the launcher change when it supports standalone
CLI help with the same isolation rules.
