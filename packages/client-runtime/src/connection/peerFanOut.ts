import { type EnvironmentId, type PeerLinkSummary, WS_METHODS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { request } from "../rpc/client.ts";
import { ConnectionOnboarding, readOidcSignInOffer } from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";

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
  function* (link: Pick<PeerLinkSummary, "environmentId" | "urls">) {
    for (const url of link.urls) {
      const peer = yield* Effect.gen(function* () {
        const offer = yield* readOidcSignInOffer(url);
        if (Option.isNone(offer)) return Option.none<PeerSignIn>();
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

/**
 * Adds each peer `findPeerSignIns` returns through the platform's `signIn`, one at a time, and
 * returns the environments added. Each peer goes to `recordAttempt` first, so a sign-in that
 * fails, is dismissed or never comes back is skipped next time; a cancelled one ends the run.
 */
export const runPeerFanOut = Effect.fn("clientRuntime.connection.peerFanOut.runPeerFanOut")(
  function* <R>(input: {
    readonly connected: ReadonlyArray<EnvironmentId>;
    readonly skip: ReadonlySet<EnvironmentId>;
    readonly signIn: (peer: PeerSignIn) => Effect.Effect<PeerSignInResult, never, R>;
    readonly recordAttempt: (peer: PeerSignIn) => Effect.Effect<void, never, R>;
  }) {
    const onboarding = yield* ConnectionOnboarding;
    const added: Array<EnvironmentId> = [];
    for (const peer of yield* findPeerSignIns(input)) {
      yield* input.recordAttempt(peer);
      const result = yield* input.signIn(peer);
      if (result._tag === "Cancelled") break;
      if (result._tag === "Failed") continue;
      const registered = yield* onboarding
        .registerPairing({
          host: peer.origin,
          pairingCode: result.pairingCode,
          expectedEnvironmentId: peer.environmentId,
        })
        .pipe(Effect.option);
      if (Option.isSome(registered)) added.push(registered.value);
    }
    return added;
  },
);
