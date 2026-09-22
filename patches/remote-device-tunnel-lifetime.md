# Remote device tunnel lifetime

Device host SSH forwards must use an independent foreground connection. With
`ControlMaster auto`, an `ssh -N -L` client can exit successfully while its
master retains the forwards. T3 supervises that client's lifetime, so this
produces reconnect loops and unavailable media despite successful discovery.

Disable connection sharing and backgrounding for the supervised tunnel only.
Bootstrap commands retain the user's SSH configuration. Remove this fork patch
when upstream device tunnels provide the same lifetime guarantee.
