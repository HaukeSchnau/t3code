import { useAtomValue } from "@effect/atom-react";
import type { PeerFanOut } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { runSignInRecovery } from "./connection/onboarding";
import { environmentSummaries } from "./state/presentation";
import { useAtomCommand } from "./state/use-atom-command";

// After a silent attempt, a host is left alone for an hour, however often it fails meanwhile.
const COOLDOWN_MS = 60 * 60 * 1000;
const tried = new Map<EnvironmentId, number>();
let running = false;
let again = false;

const failedEnvironmentsKeyAtom = Atom.make((get) =>
  get(environmentSummaries.environmentsAtom)
    .filter((environment) => environment.connectionState === "error")
    .map((environment) => environment.environmentId)
    .join(","),
);

type Recover = (
  input: Parameters<typeof PeerFanOut.runSignInRecovery<never>>[0],
) => Promise<unknown>;

export function recoverSignIns(recover: Recover): void {
  const signIn = window.desktopBridge?.signInWithOidc;
  if (signIn === undefined) return;
  // A host that fails during a run gets the next one.
  if (running) {
    again = true;
    return;
  }
  running = true;
  again = false;
  const now = Date.now();
  void recover({
    skip: new Set(
      [...tried].filter(([, at]) => now - at < COOLDOWN_MS).map(([environmentId]) => environmentId),
    ),
    signIn: (peer) =>
      Effect.promise(() =>
        signIn({ origin: peer.origin, prompt: "none" }).catch((): PeerFanOut.PeerSignInResult => ({
          _tag: "Failed",
          error: "sign_in_failed",
        })),
      ),
    recordAttempt: (peer) =>
      Clock.currentTimeMillis.pipe(Effect.map((at) => void tried.set(peer.environmentId, at))),
  }).finally(() => {
    running = false;
    if (again) recoverSignIns(recover);
  });
}

/**
 * Signs the desktop in again, in a hidden window, to saved environments whose host rejected its
 * credential. An expired session then comes back without a pairing code while the host's
 * provider still recognizes this device.
 */
export function useDesktopSignInRecovery(): void {
  const failedKey = useAtomValue(failedEnvironmentsKeyAtom);
  const recover = useAtomCommand(runSignInRecovery, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- signs in again whenever another environment's connection fails, since only the runtime knows which failures were rejections
  useEffect(() => {
    if (failedKey !== "") recoverSignIns(recover);
  }, [failedKey, recover]);
}
