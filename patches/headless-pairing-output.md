# Headless pairing output

## Purpose

`t3 serve` mints a startup pairing token with administrative scopes and prints it with its pairing
URL and a QR code. Under systemd or the background service, stdout goes to the journal and on to
log storage, so every start left a live admin credential in the logs. Upstream still prints the
headless banner unconditionally. Its `announceStartupPairingUrl` keeps the `t3 start` URL out of
log records only, and still prints it to stdout.

## Behavior

`headlessServeOutput` in `apps/server/src/startupAccess.ts` prints the full banner only when stdout
is a terminal (`StdoutIsTerminal` in `packages/shared/src/HostProcess.ts`). Otherwise it
prints one line that points to `t3 pair` and mints no startup token at all. `t3 pair` issues a
standard-scope link for the running server. The `t3 start` log line with `pairingUrl` is unchanged,
because the dev runner reads it from piped output. The infra journald filter on
`app-deployment-t3code` exists only for this banner and can go once a release with this change is
active.

## Upstream touch points

- `apps/server/src/serverRuntimeStartup.ts`: the headless startup phase calls
  `headlessServeOutput`. The startup heartbeat runs in its own fiber there, because analytics may
  hydrate the projection first and that must not delay the printed access details.

## Removal

Drop this once upstream keeps the startup token out of non-terminal output.

## Verification

`startupAccess.test.ts` covers both cases against a real in-memory `EnvironmentAuth`: a terminal
gets the URL and one issued link, anything else gets the hint and no link.
