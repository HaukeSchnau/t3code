import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const disabledSigner = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.fail(
      new ManagedRelay.ManagedRelayDpopKeyLoadError({
        keyStore: "indexed-db",
        cause: new Error("T3 Connect authentication is disabled in this fork."),
      }),
    ),
    createProof: (input) =>
      Effect.fail(
        new ManagedRelay.ManagedRelayDpopProofCreationError({
          method: input.method,
          url: input.url,
          cause: new Error("T3 Connect authentication is disabled in this fork."),
        }),
      ),
  }),
);

const disabledAccessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
  load: Effect.succeed([]),
  save: () => Effect.void,
  clear: Effect.void,
};

export const browserCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

// Connection.layer still includes the upstream managed-relay services in its
// Effect context. This fail-closed adapter satisfies that boundary without
// retaining account credentials or an operational cloud-auth path.
export const accountlessRelayCompatibilityLayer = ManagedRelay.layer({
  relayUrl: "https://relay-disabled.invalid",
  clientId: RelayWebClientId,
  accessTokenStore: disabledAccessTokenStore,
}).pipe(Layer.provideMerge(disabledSigner));
