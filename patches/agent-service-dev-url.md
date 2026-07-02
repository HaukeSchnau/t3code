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
- Vite HMR uses `AGENT_SERVICE_URL` when present, so reverse-proxied server runs connect through the public
  browser origin instead of `localhost`.
- The root `dev` package script includes a `--` separator so Portless-appended Vite flags such as `--port`,
  `--strictPort`, and `--host` are captured as `dev-runner` run args instead of being parsed as
  `dev-runner` flags.
- In agent-service context, `dev-runner` strips those forwarded Vite flags before spawning the shared Vite+
  task graph. T3 Code already applies the same bind port, host, and strict-port behavior through environment
  wiring and `apps/web/vite.config.ts`; forwarding the flags would also send them to the backend task.
- The server CLI accepts `--strictPort` as a no-op so Vite-style strict-port args remain harmless in local
  development command paths.

## Requirements

- Do not depend on the older Portless-specific `PORTLESS_URL` signal. The fork assumes the current
  `agent-service` has already been deployed everywhere T3 Code is launched this way.
- Keep explicit `--dev-url` overrides higher priority than ambient `agent-service` environment values.
- Keep the `dev` script separator unless `agent-service` stops appending Vite-style flags to managed commands.
- Keep the agent-service run-arg filter while the shared dev graph would otherwise forward Vite flags to every
  task.
