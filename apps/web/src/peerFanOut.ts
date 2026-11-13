import type { PeerFanOut } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { buildOidcSignInUrl } from "@t3tools/shared/remote";
import { useEffect, useEffectEvent } from "react";

import { findPeerSignIns } from "./connection/onboarding";
import { canSignInWithOidc } from "./oidcSignIn";
import { useConnectedEnvironmentIds } from "./state/environments";
import { useAtomCommand } from "./state/use-atom-command";

const QUEUE_KEY = "t3code:peer-fan-out";
const TRIED_KEY = "t3code:peer-fan-out-tried";
// A browser the provider does not recognize silently tries again the next day, not on every load.
const RETRY_MS = 24 * 60 * 60 * 1000;

interface PeerFanOutQueue {
  readonly returnTo: string;
  readonly current: PeerFanOut.PeerSignIn;
  readonly pending: ReadonlyArray<PeerFanOut.PeerSignIn>;
}

// Set once a step's navigation starts; the page lives on until the provider answers.
let leaving = false;

function readJson<A>(storage: Storage, key: string): A | null {
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as A);
  } catch {
    return null;
  }
}

function writeJson(storage: Storage, key: string, value: unknown): boolean {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function triedPeers(): ReadonlySet<EnvironmentId> {
  const tried = readJson<Record<string, number>>(localStorage, TRIED_KEY) ?? {};
  const now = Date.now();
  return new Set(
    Object.entries(tried)
      .filter(([, triedAt]) => now - triedAt < RETRY_MS)
      .map(([environmentId]) => environmentId as EnvironmentId),
  );
}

/**
 * Records the peer before leaving, so a step that fails, never returns or is abandoned is not
 * tried again soon. Without that record the fan-out could redirect on every load, so it stops.
 */
function signInSilently(queue: PeerFanOutQueue): boolean {
  const tried = readJson<Record<string, number>>(localStorage, TRIED_KEY) ?? {};
  if (
    !writeJson(localStorage, TRIED_KEY, { ...tried, [queue.current.environmentId]: Date.now() })
  ) {
    return false;
  }
  if (!writeJson(sessionStorage, QUEUE_KEY, queue)) return false;
  leaving = true;
  window.location.replace(
    buildOidcSignInUrl(queue.current.origin, {
      returnTo: new URL("/pair", window.location.origin).toString(),
      prompt: "none",
    }),
  );
  return true;
}

/** The fan-out's peer that `host` names, when this page is a step of one. */
export function peerFanOutStep(host: string): PeerFanOut.PeerSignIn | null {
  const queue = readJson<PeerFanOutQueue>(sessionStorage, QUEUE_KEY);
  if (queue === null || !URL.canParse(host)) return null;
  return new URL(host).origin === new URL(queue.current.origin).origin ? queue.current : null;
}

/**
 * Finishes `step` and moves on to the next peer, or back to where the fan-out started. A step
 * that is no longer current was already finished, so finishing it again does nothing.
 */
export function continuePeerFanOut(step: PeerFanOut.PeerSignIn): void {
  const queue = readJson<PeerFanOutQueue>(sessionStorage, QUEUE_KEY);
  if (queue === null || queue.current.environmentId !== step.environmentId) return;
  const [next, ...pending] = queue.pending;
  if (next !== undefined && signInSilently({ ...queue, current: next, pending })) return;
  writeJson(sessionStorage, QUEUE_KEY, null);
  window.location.replace(queue.returnTo);
}

/**
 * Adds the environments the connected ones link to, by signing in to each without a click while
 * the provider recognizes this device. Each step leaves the page and returns to `/pair`.
 */
export function usePeerFanOut(): void {
  const connectedKey = useConnectedEnvironmentIds().join(",");
  const find = useAtomCommand(findPeerSignIns, { reportFailure: false });
  const fanOut = useEffectEvent((connected: ReadonlyArray<EnvironmentId>) => {
    if (leaving || connected.length === 0 || !canSignInWithOidc()) return undefined;
    // Each step ends on /pair, so the app loading mid-queue means a step was abandoned; its
    // peer is already recorded.
    writeJson(sessionStorage, QUEUE_KEY, null);
    let cancelled = false;
    void find({ connected, skip: triedPeers() }).then((result) => {
      if (cancelled || leaving || result._tag !== "Success") return;
      const [current, ...pending] = result.value;
      if (current !== undefined) {
        signInSilently({ returnTo: window.location.href, current, pending });
      }
    });
    return () => {
      cancelled = true;
    };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the connected environments for their links whenever another one connects
  useEffect(
    () => fanOut(connectedKey === "" ? [] : (connectedKey.split(",") as Array<EnvironmentId>)),
    [connectedKey],
  );
}
