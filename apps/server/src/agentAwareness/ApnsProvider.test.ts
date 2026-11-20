// @effect-diagnostics nodeBuiltinImport:off -- the test signs with a real EC key pair and stalls a real HTTP/2 request.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  APNS_REQUEST_DEADLINE,
  ApnsProviderConfigurationError,
  apnsCollapseId,
  makeApnsHeaders,
  makeApnsProviderToken,
  makeBadgeRequest,
  makeLiveActivityPayload,
  makeNotificationPayload,
  resolveApnsProviderConfiguration,
  sendApnsRequest,
} from "./ApnsProvider.ts";

describe("accountless APNs provider", () => {
  it("creates an ES256 provider token accepted by the configured public key", () => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const token = makeApnsProviderToken({
      credentials: {
        teamId: "2243J9RD68",
        keyId: "KEY1234567",
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      },
      issuedAtUnixSeconds: 1_786_300_000,
    });
    const [header, payload, signature] = token.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toEqual({
      iss: "2243J9RD68",
      iat: 1_786_300_000,
    });
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        {
          key: publicKey,
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("builds ActivityKit update and end payloads without remote-start fields", () => {
    const aggregate = {
      title: "T3 Code",
      subtitle: "Agent work in progress",
      activeCount: 1,
      updatedAt: "2026-08-10T12:00:00.000Z",
      activities: [],
    };

    expect(
      makeLiveActivityPayload({
        event: "update",
        state: aggregate,
        nowEpochSeconds: 100,
      }),
    ).toEqual({
      aps: {
        timestamp: 100,
        event: "update",
        "content-state": { name: "AgentActivity", props: JSON.stringify(aggregate) },
        "stale-date": 700,
      },
    });
    expect(makeLiveActivityPayload({ event: "end", state: null, nowEpochSeconds: 100 })).toEqual({
      aps: { timestamp: 100, event: "end", "dismissal-date": 115 },
    });
  });

  it("keeps notification routing metadata outside the aps dictionary", () => {
    expect(
      makeNotificationPayload({
        title: "Question",
        body: "Input: T3 Code",
        environmentId: "environment-1",
        threadId: "thread-1",
        deepLink: "/environment/environment-1/thread/thread-1",
        category: "AGENT_INPUT",
        interruptionLevel: "time-sensitive",
        badge: 3,
      }),
    ).toEqual({
      aps: {
        alert: { title: "Question", body: "Input: T3 Code" },
        sound: "default",
        "thread-id": "environment-1/thread-1",
        category: "AGENT_INPUT",
        "interruption-level": "time-sensitive",
        badge: 3,
      },
      environmentId: "environment-1",
      threadId: "thread-1",
      deepLink: "/environment/environment-1/thread/thread-1",
    });
    // An ask that replaces its run's "Done" makes no sound.
    expect(
      makeNotificationPayload({
        title: "Question",
        body: "Pick one",
        environmentId: "environment-1",
        threadId: "thread-1",
        deepLink: "/",
        silent: true,
      }).aps,
    ).not.toHaveProperty("sound");
  });

  it("collapses alerts by key and lets a badge-only push expire instead of waiting", () => {
    const target = {
      token: "token",
      bundleId: "dev.schnau.t3code",
      environment: "sandbox",
    } as const;
    const badge = makeBadgeRequest(4);
    // A count change alone sets the icon without an alert or sound.
    expect(badge.payload).toEqual({ aps: { badge: 4 } });
    expect(makeApnsHeaders({ target, providerToken: "jwt", ...badge })).toMatchObject({
      "apns-push-type": "alert",
      "apns-priority": "5",
      "apns-expiration": "0",
    });
    const alert = makeApnsHeaders({
      target,
      providerToken: "jwt",
      pushType: "alert",
      priority: "10",
      collapseId: apnsCollapseId("run:1"),
    });
    expect(alert).toMatchObject({ "apns-collapse-id": apnsCollapseId("run:1") });
    expect(alert).not.toHaveProperty("apns-expiration");
    expect(apnsCollapseId("run:".repeat(70))).toHaveLength(32);
    expect(apnsCollapseId("run:1")).not.toBe(apnsCollapseId("run:2"));
  });

  it("requires a complete provider configuration and supports key files", () => {
    expect(resolveApnsProviderConfiguration({})).toBeNull();
    expect(
      resolveApnsProviderConfiguration({
        T3CODE_APNS_TEAM_ID: "2243J9RD68",
        T3CODE_APNS_KEY_ID: "KEY1234567",
        T3CODE_APNS_PRIVATE_KEY_FILE: "/run/secrets/AuthKey.p8",
      }),
    ).toEqual({
      teamId: "2243J9RD68",
      keyId: "KEY1234567",
      privateKeySource: { kind: "file", value: "/run/secrets/AuthKey.p8" },
    });
    expect(() => resolveApnsProviderConfiguration({ T3CODE_APNS_TEAM_ID: "2243J9RD68" })).toThrow(
      ApnsProviderConfigurationError,
    );
  });

  it.effect("closes a request APNs never answers at its deadline, so it holds nothing up", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      // An APNs stand-in that takes the request and never answers.
      const server = NodeHttp2.createServer();
      const sessions = new Set<NodeHttp2.ServerHttp2Session>();
      server.on("session", (session) => {
        sessions.add(session);
        session.on("close", () => sessions.delete(session));
      });
      server.on("stream", (stream) => {
        Deferred.doneUnsafe(received, Exit.void);
        stream.on("close", () => Deferred.doneUnsafe(closed, Exit.void));
      });
      const port = yield* Effect.acquireRelease(
        Effect.callback<number>((resume) => {
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resume(Effect.succeed(typeof address === "object" && address ? address.port : 0));
          });
        }),
        // `close` waits for open sessions. One a broken deadline left open, after the test
        // already failed waiting for its stream to close, would hold up teardown.
        () =>
          Effect.callback<void>((resume) => {
            for (const session of sessions) session.destroy();
            server.close(() => resume(Effect.void));
          }),
      );
      const request = yield* Effect.forkChild(
        sendApnsRequest({
          origin: `http://127.0.0.1:${port}`,
          headers: makeApnsHeaders({
            target: {
              token: "device-token",
              bundleId: "com.t3tools.t3code",
              environment: "sandbox",
            },
            providerToken: "provider-token",
            pushType: "alert",
            priority: "10",
          }),
          payload: { aps: { badge: 1 } },
          tokenSuffix: "e-token",
        }),
      );
      yield* Deferred.await(received);
      yield* TestClock.adjust(APNS_REQUEST_DEADLINE);
      const exit = yield* Fiber.await(request);
      expect(Exit.isFailure(exit)).toBe(true);
      // The stalled stream is gone, not left open on a session someone else waits behind.
      yield* Deferred.await(closed);
    }).pipe(Effect.scoped),
  );
});
