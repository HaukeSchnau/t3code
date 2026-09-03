import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  primaryRegistrationToRetainAfterTopologyRead,
  persistPrimaryEnvironmentDescriptor,
  provisionDesktopSshEnvironment,
  readPrimaryEnvironmentTargetResult,
  readPersistedPrimaryConnectionRegistration,
  retainPrimaryRegistrationAfterRefreshFailure,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
} from "./platform.ts";

function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => vi.unstubAllGlobals());

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

function makeBridge(
  calls: string[],
  options?: { readonly failDescriptor?: boolean },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (target: DesktopSshEnvironmentTarget) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: "pairing-token",
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);

      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failDescriptor: true }),
        TARGET,
      ).pipe(Effect.flip);

      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });

  it("backs off descriptor refresh failures and never retains a changed target", () => {
    const first = retainPrimaryRegistrationAfterRefreshFailure(cached, cached.signature, 10_000);
    expect(first).toMatchObject({ primaryRefreshFailureCount: 1, refreshAtEpochMs: 13_000 });
    expect(
      retainPrimaryRegistrationAfterRefreshFailure(first!, cached.signature, 13_000),
    ).toMatchObject({ primaryRefreshFailureCount: 2, refreshAtEpochMs: 19_000 });
    expect(
      retainPrimaryRegistrationAfterRefreshFailure(
        cached,
        "https://new.example/|wss://new.example/",
        10_000,
      ),
    ).toBeNull();
  });

  it("reconstructs a target-bound primary registration for an authenticated offline reload", () => {
    const origin = "https://app.example.test";
    const localStorage = makeStorage();
    vi.stubGlobal("window", {
      location: new URL(`${origin}/environment/thread`),
      localStorage,
    });
    localStorage.setItem(
      "t3code:primary-authenticated:v1",
      JSON.stringify({
        version: 1,
        browserOrigin: origin,
        primaryTargetSignature: `${origin}/|wss://app.example.test/`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    const target = {
      source: "window-origin",
      target: { httpBaseUrl: `${origin}/`, wsBaseUrl: `wss://app.example.test/` },
    } as const;
    persistPrimaryEnvironmentDescriptor(target, {
      environmentId: EnvironmentId.make("environment-cached"),
      label: "Cached environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    });

    expect(readPersistedPrimaryConnectionRegistration(target)?.target).toMatchObject({
      environmentId: "environment-cached",
      label: "Cached environment",
      httpBaseUrl: `${origin}/`,
      wsBaseUrl: "wss://app.example.test/",
    });

    persistPrimaryEnvironmentDescriptor(target, {
      environmentId: EnvironmentId.make("environment-replaced"),
      label: "Recovered environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.1-test",
      capabilities: { repositoryIdentity: true },
    });
    expect(readPersistedPrimaryConnectionRegistration(target)?.target).toMatchObject({
      environmentId: "environment-replaced",
      label: "Recovered environment",
    });
  });

  it("does not reconstruct a primary registration without exact authenticated proof", () => {
    const origin = "https://app.example.test";
    const localStorage = makeStorage();
    vi.stubGlobal("window", {
      location: new URL(`${origin}/`),
      localStorage,
    });
    const target = {
      source: "window-origin",
      target: { httpBaseUrl: `${origin}/`, wsBaseUrl: "wss://app.example.test/" },
    } as const;
    persistPrimaryEnvironmentDescriptor(target, {
      environmentId: EnvironmentId.make("environment-cached"),
      label: "Cached environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    });

    expect(readPersistedPrimaryConnectionRegistration(target)).toBeNull();
  });
});
