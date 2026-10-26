# Agent-service dev URL

## Why this patch exists

This fork is commonly launched through Hauke's `agent-service` wrapper on both macOS and VPS hosts.
`agent-service` now provides a cross-platform `AGENT_SERVICE_URL` environment variable with the canonical
browser-facing origin: a Portless `*.localhost` URL on macOS and a Caddy-backed `*.schnau.dev` URL on
servers.

## Behavior

- `scripts/dev-runner.ts` treats `AGENT_SERVICE_URL` as the canonical `VITE_DEV_SERVER_URL`.
- `AGENT_SERVICE_PORT` remains the preferred app bind port on Linux/VPS.
- On macOS, where `AGENT_SERVICE_PORT` is not provided, `PORT` is accepted as the app bind port only when
  `AGENT_SERVICE_URL` is present.
- Vite HMR follows upstream and derives its socket from the page origin, which already covers
  reverse-proxied `AGENT_SERVICE_URL` and `--dev-url` origins.
- `dev-runner` `--web-host` and `--web-port` bind the Vite listener through `HOST` and `PORT`. The devenv
  `web` process uses them to listen where the Project Runtime proxies. Upstream pins HMR to any explicit
  `HOST` for Electron, so `apps/web/vite.config.ts` skips that pin in single-origin browser dev; otherwise
  a remote browser would try the listener address, such as `127.0.0.1`, on its own machine.
- The root `dev` package script includes a `--` separator so Portless-appended Vite flags such as `--port`,
  `--strictPort`, and `--host` are captured as `dev-runner` run args instead of being parsed as
  `dev-runner` flags.
- In agent-service context, `dev-runner` strips those forwarded Vite flags before spawning the shared Vite+
  task graph. T3 Code already applies the same bind port, host, and strict-port behavior through environment
  wiring and `apps/web/vite.config.ts`; forwarding the flags would also send them to the backend task.
- The server CLI accepts `--strictPort` as a no-op so Vite-style strict-port args remain harmless in local
  development command paths.
- `apps/server/src/http.ts` `isLoopbackHostname` treats `*.localhost` as loopback, so a Portless origin
  gets the dev-server redirect. The fork exports the function for its test in `http.test.ts`.

## Requirements

- Do not depend on the older Portless-specific `PORTLESS_URL` signal. The fork assumes the current
  `agent-service` has already been deployed everywhere T3 Code is launched this way.
- Keep explicit `--dev-url` overrides higher priority than ambient `agent-service` environment values.
- Keep the `dev` script separator unless `agent-service` stops appending Vite-style flags to managed commands.
- Keep the agent-service run-arg filter while the shared dev graph would otherwise forward Vite flags to every
  task.
- Keep the single-origin exception to upstream's HMR pin while devenv binds an explicit web listener. It can go
  if upstream stops pinning HMR to `HOST` outside Electron or gains its own web listener flag.
