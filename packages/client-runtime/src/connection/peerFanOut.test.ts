import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RpcHttp from "../rpc/http.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { ConnectionOnboarding, type PairingConnectionInput } from "./onboarding.ts";
import { findPeerSignIns, runPeerFanOut, type PeerSignIn } from "./peerFanOut.ts";
import * as EnvironmentRegistry from "./registry.ts";

const HOME = EnvironmentId.make("home");
const OFFICE = EnvironmentId.make("office");
const TOWER = EnvironmentId.make("tower");
const KNOWN = EnvironmentId.make("known");
const OLD = EnvironmentId.make("old");
const PLAIN = EnvironmentId.make("plain");

/** Hosts by name: which environment answers there and whether it offers sign-in. */
const HOSTS: Record<string, { readonly environmentId: string; readonly signIn: boolean }> = {
  "office.test": { environmentId: "office", signIn: true },
  "moved.test": { environmentId: "someone-else", signIn: true },
  "tower.test": { environmentId: "tower", signIn: true },
  "plain.test": { environmentId: "plain", signIn: false },
  "known.test": { environmentId: "known", signIn: true },
  "old.test": { environmentId: "old", signIn: true },
};

const fetchFn = ((input) => {
  const url = new URL(String(input));
  const host = HOSTS[url.hostname];
  if (host === undefined) return Promise.reject(new Error(`unreachable ${url.hostname}`));
  if (url.pathname === "/.well-known/t3/environment") {
    return Promise.resolve(
      Response.json({
        environmentId: host.environmentId,
        label: host.environmentId,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      }),
    );
  }
  return Promise.resolve(
    Response.json({
      authenticated: false,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "t3_session",
        ...(host.signIn ? { oidc: { label: "Schnau ID", origin: url.origin } } : {}),
      },
    }),
  );
}) satisfies typeof fetch;

const link = (
  environmentId: EnvironmentId,
  urls: ReadonlyArray<string>,
  status: PeerLinkSummary["status"] = "reachable",
): PeerLinkSummary => ({
  environmentId,
  label: environmentId,
  urls,
  access: "full-access",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
  lastReachedAt: null,
  lastError: null,
  status,
});

/** Each connected environment's links, as `peerLinks.list` answers. */
const LINKS: ReadonlyMap<EnvironmentId, ReadonlyArray<PeerLinkSummary>> = new Map([
  [
    HOME,
    [
      // HOME reaches OFFICE at an address that now answers as another machine.
      link(OFFICE, ["https://moved.test"]),
      link(KNOWN, ["https://known.test"]),
      link(OLD, ["https://old.test"], "expired"),
      link(PLAIN, ["https://plain.test"]),
    ],
  ],
  [OFFICE, []],
  [TOWER, [link(OFFICE, ["https://office.test"]), link(TOWER, ["https://tower.test"])]],
]);

const makeLayer = (registrations: Array<PairingConnectionInput>) =>
  Layer.mergeAll(
    RpcHttp.layerRemoteHttpClient(fetchFn),
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        new Map([[KNOWN, {} as ConnectionCatalogEntry]]),
      ).pipe(
        Effect.map((entries) =>
          EnvironmentRegistry.EnvironmentRegistry.of({
            entries,
            // The test answers `peerLinks.list` itself instead of running the request.
            run: (environmentId: EnvironmentId) =>
              Effect.succeed({ links: LINKS.get(environmentId) ?? [] }) as never,
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
      ),
    ),
    Layer.mock(ConnectionOnboarding)({
      registerPairing: (input) =>
        Effect.sync(() => {
          registrations.push(input);
          return input.expectedEnvironmentId!;
        }),
    }),
  );

describe("peer fan-out", () => {
  it.effect("offers each linked environment this client lacks once, at an address that is it", () =>
    Effect.gen(function* () {
      const peers = yield* findPeerSignIns({ connected: [HOME, TOWER], skip: new Set() });
      // TOWER is connected, KNOWN is saved, OLD's link expired and PLAIN offers no sign-in.
      // OFFICE answers only at the address TOWER links it by.
      expect(peers).toEqual([{ environmentId: OFFICE, origin: "https://office.test" }]);
    }).pipe(Effect.provide(makeLayer([]))),
  );

  it.effect("registers each signed-in peer once and skips a tried one next time", () => {
    const registrations: Array<PairingConnectionInput> = [];
    return Effect.gen(function* () {
      const tried = new Set<EnvironmentId>();
      const signIns: Array<PeerSignIn> = [];
      const run = () =>
        runPeerFanOut({
          connected: [HOME, TOWER],
          skip: tried,
          signIn: (peer) =>
            Effect.sync(() => {
              signIns.push(peer);
              return signIns.length === 1
                ? { _tag: "Failed" as const, error: "login_required" }
                : { _tag: "Signed" as const, pairingCode: "CODE" };
            }),
          recordAttempt: (peer) => Effect.sync(() => void tried.add(peer.environmentId)),
        });

      expect(yield* run()).toEqual([]);
      expect([...tried]).toEqual([OFFICE]);
      expect(yield* run()).toEqual([]);
      expect(signIns).toHaveLength(1);

      tried.clear();
      expect(yield* run()).toEqual([OFFICE]);
      expect(registrations).toEqual([
        { host: "https://office.test", pairingCode: "CODE", expectedEnvironmentId: OFFICE },
      ]);
    }).pipe(Effect.provide(makeLayer(registrations)));
  });
});
