# Health route

## Requirement

Deployments need an unauthenticated readiness probe. The managed project runner polls `/healthz`
for the development service (`devenv.nix`), the release (`project.nix`), and infra's project checks
(`modules/system/nixos/services/vps/projects/checks.nix`). It must not depend on a pairing token
and must not answer before the server can serve commands.

## Why upstream doesn't meet it

Upstream has no health endpoint. Every other route either needs an authenticated session or serves
the web app, which answers before startup has finished.

## Implementation

`layerHealthRoute` in `apps/server/src/http.ts` answers `GET /healthz` with an empty 204 and does
no other work. `server.ts` mounts it with the other routes, so the global command-readiness
middleware holds it until startup, including migrations, has finished. That is why the release sets
a 30-minute `startupTimeoutSec`. `http.test.ts` covers the response.

## Removal

Switch the three probes to upstream's route and delete this one if upstream adds an
unauthenticated readiness endpoint with the same startup gating.
