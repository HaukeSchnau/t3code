# Linked environment sign-in

## Purpose

[OIDC sign-in](oidc-sign-in.md) lets a device sign in to one server without a code. The fleet links
every server to every other one, so a client connected to one server already learns the others
from its links. This patch signs the client in to those as well, so a new fleet host reaches the
MacBook and the iPhone without a tap.

## Behavior

- `packages/client-runtime/src/connection/peerFanOut.ts` asks every connected environment for its
  links (`peerLinks.list`; an environment without `access:read` adds nothing). It keeps live links to
  environments the client has not saved, skips the ones the platform tried in the last day, and
  keeps an address, from any environment's link, only when it offers sign-in and its sign-in origin
  answers as the linked environment. `runPeerFanOut` records each peer as tried, signs in through a
  platform hook and registers it with `ConnectionOnboarding.registerPairing` and the expected
  environment id. Recording before the sign-in covers the ones that fail, are dismissed or never
  come back. A cancelled sign-in, or a sheet that cannot open because the device has no browser,
  ends the run. A sign-in started while another sheet is up waits for it to close.
- Web (`apps/web/src/peerFanOut.ts`) signs in with `prompt=none` through top-level redirects, since
  a page cannot open a provider's page in the background. The queue lives in `sessionStorage`; each
  step returns to `/pair`, which pairs with the expected id and moves on, and the last step returns
  to where the fan-out started. Tried peers are kept in `localStorage` for a day, so a browser the
  provider does not recognize silently does not bounce through it on every load; when that write
  fails, the fan-out does not start. The desktop renderer does not fan out.
- Mobile runs the fan-out whenever the connected environments change, with a silent ephemeral sheet
  per peer, and keeps tried peers in SecureStore for a day. **Settings → Environments → Linked from
  … → Add to this device** signs in to one linked environment interactively, at an address that
  answers as it.
- A removed environment is added again while a connected one links to it. Turning it off keeps it
  saved, so the fan-out leaves it alone; that is the way to keep a linked environment off a device.

## Upstream touch points

- `packages/client-runtime/src/connection/index.ts` exports it.
- `apps/web/src/routes/_chat.tsx` mounts the fan-out, `PairingRouteSurface.tsx` continues it, and
  `apps/web/src/connection/onboarding.ts` has its command.
- `apps/mobile/src/App.tsx` installs it, `LinkedEnvironmentsSection.tsx` has the manual action, and
  `apps/mobile/src/connection/onboarding.ts` has the commands.

## Removal

Drop this with OIDC sign-in, or when upstream lets a client add the environments its environments
link to.

## Verification

`packages/client-runtime/src/connection/peerFanOut.test.ts` covers the set of peers offered (saved,
connected, expired and sign-in-less links left out, every linking environment's addresses tried,
an address that reaches another machine skipped), one registration per peer, and a tried peer
skipped on the next run.
