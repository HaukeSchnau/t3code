import { type EnvironmentId, type PeerLinkSummary, WS_METHODS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { request } from "../rpc/client.ts";
import { ConnectionOnboarding, readOidcSignInOffer } from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

/** An environment a connected one links to, which this client lacks, and where to sign in to it. */
export interface PeerSignIn {
  readonly environmentId: EnvironmentId;
  readonly origin: string;
}

export type PeerSignInResult =
  | { readonly _tag: "Signed"; readonly pairingCode: string }
  | { readonly _tag: "Failed"; readonly error: string }
  | { readonly _tag: "Cancelled" };

/** The first of a link's addresses that offers sign-in where the linked environment answers. */
export const resolvePeerSignIn = Effect.fn("clientRuntime.connection.peerFanOut.resolvePeerSignIn")(
  function* (
    link: Pick<PeerLinkSummary, "environmentId" | "urls">,
    options?: {
      /** Skip an address whose sign-in lives at an origin that is not one of `urls`. */
      readonly listedOriginsOnly?: boolean;
    },
  ) {
    const listed = new Set(
      link.urls.flatMap((url) => (URL.canParse(url) ? [new URL(url).origin] : [])),
    );
    for (const url of link.urls) {
      const peer = yield* Effect.gen(function* () {
        const offer = yield* readOidcSignInOffer(url);
        if (Option.isNone(offer)) return Option.none<PeerSignIn>();
        if (options?.listedOriginsOnly === true && !listed.has(offer.value.origin)) {
          return Option.none<PeerSignIn>();
        }
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: offer.value.origin,
        });
        // An address that now reaches another machine must not receive this one's sign-in.
        if (descriptor.environmentId !== link.environmentId) return Option.none<PeerSignIn>();
        return Option.some<PeerSignIn>({
          environmentId: link.environmentId,
          origin: offer.value.origin,
        });
      }).pipe(Effect.orElseSucceed(Option.none<PeerSignIn>));
      if (Option.isSome(peer)) return peer;
    }
    return Option.none<PeerSignIn>();
  },
);

/**
 * The live links of the connected environments that point at environments this client lacks
 * and that offer sign-in. `skip` holds environments tried recently.
 */
export const findPeerSignIns = Effect.fn("clientRuntime.connection.peerFanOut.findPeerSignIns")(
  function* (input: {
    readonly connected: ReadonlyArray<EnvironmentId>;
    readonly skip: ReadonlySet<EnvironmentId>;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const known = new Set([
      ...(yield* SubscriptionRef.get(registry.entries)).keys(),
      ...input.connected,
    ]);
    const now = yield* DateTime.now;
    const lists = yield* Effect.forEach(
      input.connected,
      (environmentId) =>
        registry.run(environmentId, request(WS_METHODS.peerLinksList, {})).pipe(
          Effect.map(({ links }) => links),
          // Without access:read an environment hides its links; it adds no peers then.
          Effect.orElseSucceed((): ReadonlyArray<PeerLinkSummary> => []),
        ),
      { concurrency: "unbounded" },
    );
    // Each environment lists the addresses it reaches a peer at, so all of them are tried.
    const urls = new Map<EnvironmentId, Array<string>>();
    for (const link of lists.flat()) {
      if (known.has(link.environmentId) || input.skip.has(link.environmentId)) continue;
      if (link.status === "expired" || DateTime.isLessThanOrEqualTo(link.expiresAt, now)) continue;
      const seen = urls.get(link.environmentId) ?? [];
      urls.set(link.environmentId, [...seen, ...link.urls.filter((url) => !seen.includes(url))]);
    }
    const found = yield* Effect.forEach(
      urls,
      ([environmentId, peerUrls]) => resolvePeerSignIn({ environmentId, urls: peerUrls }),
      { concurrency: "unbounded" },
    );
    return found.flatMap((peer) => Option.toArray(peer));
  },
);

interface PlatformSignIn<R> {
  readonly signIn: (peer: PeerSignIn) => Effect.Effect<PeerSignInResult, never, R>;
  readonly recordAttempt: (peer: PeerSignIn) => Effect.Effect<void, never, R>;
}

/**
 * Pairs with each peer through the platform's `signIn`, one at a time, and returns the
 * environments paired. Each peer goes to `recordAttempt` first, so a sign-in that fails, is
 * dismissed or never comes back is skipped next time; a cancelled one ends the run.
 */
const signInEach = Effect.fn("clientRuntime.connection.peerFanOut.signInEach")(function* <R>(
  peers: ReadonlyArray<PeerSignIn>,
  input: PlatformSignIn<R> & { readonly savedRouteOnly?: boolean },
) {
  const onboarding = yield* ConnectionOnboarding;
  const added: Array<EnvironmentId> = [];
  for (const peer of peers) {
    yield* input.recordAttempt(peer);
    const result = yield* input.signIn(peer);
    if (result._tag === "Cancelled") break;
    if (result._tag === "Failed") continue;
    const registered = yield* onboarding
      .registerPairing({
        host: peer.origin,
        pairingCode: result.pairingCode,
        expectedEnvironmentId: peer.environmentId,
        ...(input.savedRouteOnly === true ? { savedRouteOnly: true } : {}),
      })
      .pipe(Effect.option);
    if (Option.isSome(registered)) added.push(registered.value);
  }
  return added;
});

/** Adds each peer `findPeerSignIns` returns through `signInEach`. */
export const runPeerFanOut = Effect.fn("clientRuntime.connection.peerFanOut.runPeerFanOut")(
  function* <R>(
    input: PlatformSignIn<R> & {
      readonly connected: ReadonlyArray<EnvironmentId>;
      readonly skip: ReadonlySet<EnvironmentId>;
    },
  ) {
    return yield* signInEach(yield* findPeerSignIns(input), input);
  },
);

/**
 * Saved environments whose host rejected this device's credential and that offer sign-in at an
 * address they are saved at. Their connections wait for a person until then. An address only a
 * host advertises could hand this device to another server, so recovery never adds one.
 */
const findRejectedSignIns = Effect.fn("clientRuntime.connection.peerFanOut.findRejectedSignIns")(
  function* (input: { readonly skip: ReadonlySet<EnvironmentId> }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const rejected: Array<{ environmentId: EnvironmentId; urls: Array<string> }> = [];
    for (const [environmentId, entry] of yield* SubscriptionRef.get(registry.entries)) {
      if (!entry.enabled || input.skip.has(environmentId)) continue;
      const state = yield* registry.state(environmentId).pipe(Effect.option);
      if (
        Option.isNone(state) ||
        state.value.phase !== "blocked" ||
        state.value.lastFailure?.reason !== "authentication"
      ) {
        continue;
      }
      // Only direct routes the person saved pair; T3 Connect and SSH sign in their own ways, and a
      // learned route is an address the host advertised.
      const urls = connectionRoutes(entry).flatMap((route) => {
        const profile = Option.getOrNull(route.profile);
        const learned = profile?._tag === "BearerConnectionProfile" && profile.learned === true;
        const url =
          route.target._tag === "BearerConnectionTarget" && !learned
            ? routeHttpBaseUrl(route)
            : null;
        return url === null ? [] : [url];
      });
      if (urls.length > 0) rejected.push({ environmentId, urls });
    }
    const found = yield* Effect.forEach(
      rejected,
      (environment) => resolvePeerSignIn(environment, { listedOriginsOnly: true }),
      { concurrency: "unbounded" },
    );
    return found.flatMap((peer) => Option.toArray(peer));
  },
);

/** Signs each environment `findRejectedSignIns` returns in again through `signInEach`. */
export const runSignInRecovery = Effect.fn("clientRuntime.connection.peerFanOut.runSignInRecovery")(
  function* <R>(input: PlatformSignIn<R> & { readonly skip: ReadonlySet<EnvironmentId> }) {
    return yield* signInEach(yield* findRejectedSignIns(input), {
      ...input,
      savedRouteOnly: true,
    });
  },
);
