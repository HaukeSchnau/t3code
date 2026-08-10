import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ExpoCrypto from "expo-crypto";

function toExpoDigestAlgorithm(
  algorithm: Crypto.DigestAlgorithm,
): ExpoCrypto.CryptoDigestAlgorithm {
  switch (algorithm) {
    case "SHA-1":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA1;
    case "SHA-256":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA256;
    case "SHA-384":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA384;
    case "SHA-512":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA512;
  }
}

const disabledSigner = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.fail(
      new ManagedRelay.ManagedRelayDpopKeyLoadError({
        keyStore: "expo-secure-store",
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

export const mobileCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: ExpoCrypto.getRandomBytes,
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await ExpoCrypto.digest(toExpoDigestAlgorithm(algorithm), input));
      }),
  }),
);

// Connection.layer still carries the upstream managed-relay services in its
// Effect context. Supplying an intentionally unusable adapter keeps direct
// paired connections type-correct without retaining account credentials or a
// hidden cloud-auth path.
export const accountlessRelayCompatibilityLayer = ManagedRelay.layer({
  relayUrl: "https://relay-disabled.invalid",
  clientId: RelayMobileClientId,
  accessTokenStore: disabledAccessTokenStore,
}).pipe(Layer.provideMerge(disabledSigner));
