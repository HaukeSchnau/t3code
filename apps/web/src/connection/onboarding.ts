import { ConnectionOnboarding, PeerFanOut } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});

export const readOidcSignInOffer = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:read-oidc-sign-in-offer",
  scheduler: onboardingScheduler,
  concurrency: { mode: "singleFlight", key: (host: string) => host },
  execute: (host: string) => ConnectionOnboarding.readOidcSignInOffer(host),
});

export const findPeerSignIns = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:find-peer-sign-ins",
  scheduler: onboardingScheduler,
  concurrency: { mode: "latest", key: () => "find-peer-sign-ins" },
  execute: (input: Parameters<typeof PeerFanOut.findPeerSignIns>[0]) =>
    PeerFanOut.findPeerSignIns(input),
});
