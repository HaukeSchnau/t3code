import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import {
  ApnsProviderConfigurationError,
  makeApnsProviderToken,
  makeLiveActivityPayload,
  makeNotificationPayload,
  resolveApnsProviderConfiguration,
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
        title: "Approval needed",
        body: "Review: T3 Code",
        environmentId: "environment-1",
        threadId: "thread-1",
        deepLink: "/environment/environment-1/thread/thread-1",
      }),
    ).toEqual({
      aps: {
        alert: { title: "Approval needed", body: "Review: T3 Code" },
        sound: "default",
      },
      environmentId: "environment-1",
      threadId: "thread-1",
      deepLink: "/environment/environment-1/thread/thread-1",
    });
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
});
