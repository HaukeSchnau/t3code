# Device host wake

Hauke's `tower` runs Android emulators and suspends when idle. An agent that called `device_list`
while it slept saw "Could not connect to this host over SSH" and gave up.

An SSH device host may carry `wakeCommand` (`packages/contracts/src/device.ts`), an argv the server
runs before it connects to a host it has no connection to (`ensureReady` in
`apps/server/src/device/SshDeviceHost.ts`), so listing or opening its devices wakes it. The command
exits once the host answers SSH, or fails with the reason on stderr, which reaches the user and the
agent (`sshHostFailureMessage` in `DeviceService.ts`). The reconnect loop never runs it, so a host
that went to sleep stays asleep until someone asks for its devices.

infra sets the field in `settings.json` (`modules/features/t3/device-hosts.nix`); the settings UI
keeps it when a host is edited but has no control for it.

Remove this when upstream can wake a sleeping device host before connecting.
