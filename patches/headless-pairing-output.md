# Headless pairing output

## Purpose

`t3 serve` mints a startup pairing token with administrative scopes and prints it with its pairing
URL and a QR code. Under systemd or the background service, stdout goes to the journal and on to
log storage, so every start left a live admin credential in the logs. Upstream prints the banner
unconditionally.

## Behavior

`headlessServeOutput` in `apps/server/src/startupAccess.ts` prints the full banner only when stdout
is a terminal (`HostProcessStdoutIsTerminal` in `packages/shared/src/hostProcess.ts`). Otherwise it
prints one line that points to `t3 pair` and mints no startup token at all. `t3 pair` issues a
standard-scope link for the running server. The `t3 start` log line with `pairingUrl` is unchanged,
because the dev runner reads it from piped output. The infra journald filter on
`app-deployment-t3code` exists only for this banner and can go once a release with this change is
active.

## Upstream touch points

- `apps/server/src/serverRuntimeStartup.ts`: the headless startup phase calls
  `headlessServeOutput`.

## Removal

Drop this once upstream keeps the startup token out of non-terminal output.

## Verification

`startupAccess.test.ts` covers both cases against a real in-memory `EnvironmentAuth`: a terminal
gets the URL and one issued link, anything else gets the hint and no link.
