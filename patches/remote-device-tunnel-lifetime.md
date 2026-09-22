# Remote device tunnel lifetime

Device host SSH forwards must use an independent foreground connection. With
`ControlMaster auto`, an `ssh -N -L` client can exit successfully while its
master retains the forwards. T3 supervises that client's lifetime, so this
produces reconnect loops and unavailable media despite successful discovery.

Disable connection sharing and backgrounding for the supervised tunnel only.
Bootstrap commands retain the user's SSH configuration. Remove this fork patch
when upstream device tunnels provide the same lifetime guarantee.

Uploads and concurrent device commands can delay HTTP health responses beyond
the five-second deadline. A deadline alone must not replace the tunnel and its
local ports, since active clients still use those ports. Initial readiness allows
60 seconds with five-second probes for slow SSH authentication and network links.
Ignore inconclusive
timeouts and require three consecutive definite failures before repairing a
helper. An SSH process exit still triggers immediate reconnection; SSH keepalives
handle lost transport connections. This does not detect a helper that accepts
connections but hangs indefinitely. Such a host can be reconnected explicitly.

The generated agent-device launcher also allows topic help without requiring a
selected device. Operational commands still require explicit config and session.
Remove these additions when upstream preserves active uploads during health
checks and supports standalone CLI help with the same isolation rules.
