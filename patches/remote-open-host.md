# Remote open via configured SSH alias

## Goal

Make the header "Open" button work from a browser on another machine (a MacBook
viewing `t3.schnau.dev` served by `srv-2`) by handing the local editor an SSH deep
link that resolves through the viewer's own `~/.ssh/config`.

## Why upstream's version fails here

Upstream advertises hosts the server can probe (tailnet MagicDNS name, then
`<hostname>.local`) gated on an sshd listener at port 22, and offers VS Code only
in browsers. On the fleet:

- sshd listens on 2222 (tailscale0 only) and port 22 belongs to a haproxy forwarder,
  so the probe passes for the wrong daemon and a bare hostname reaches the wrong port.
- The release unit has no `tailscale` on PATH, so only `srv-2.local` is advertised.
- Workstations run VSCodium and Cursor, not VS Code, so `vscode://` has no handler.

## Patch

- `T3CODE_REMOTE_OPEN_HOST` (server env) advertises one target of kind
  `configured` and skips probing. Infra sets it to the host's managed ssh alias,
  which `lib/managed-hosts.nix` renders into every workstation's ssh config with
  the right user, port and key.
- In a browser, remote-link mode offers every remote-capable editor (VS Code first,
  then VSCodium, Cursor, Zed and the other forks) and remembers the pick. The
  desktop app keeps probing its own machine.
- The preferred-editor fallback is the first available editor in the caller's
  order instead of catalog order, so the browser list can lead with VS Code while
  server PATH probes keep their catalog order.

## Upstream maintenance

The env var and the `configured` kind are upstream-shaped and can be offered as-is.
If upstream grows an operator-declared alias or a browser editor picker, adopt it
and drop the matching part here. Infra owns the alias value in
`modules/system/nixos/services/vps/ai/default.nix`.
