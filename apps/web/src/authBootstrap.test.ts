import {
  AuthAdministrativeScopes,
  AuthDiagnosticsCaptureScope,
  EnvironmentAuthInvalidError,
  type AuthBrowserSessionResult,
  type AuthCreatePairingCredentialInput,
  type AuthSessionState,
  type DesktopBridge,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installEnvironmentHttpTest } from "../test/environmentHttpTest";
import { __setPrimaryHttpRunnerForTests, type PrimaryHttpEffectRunner } from "./lib/runtime";

type TestWindow = {
  location: URL;
  localStorage: Storage;
  history: {
    replaceState: (_data: unknown, _unused: string, url: string) => void;
  };
  desktopBridge?: DesktopBridge;
};

const LOOPBACK_AUTH = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

const DESKTOP_AUTH = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

const SESSION_EXPIRES_AT = DateTime.makeUnsafe("2026-04-05T00:00:00.000Z");
const unauthenticatedSession = (auth: AuthSessionState["auth"]): AuthSessionState => ({
  authenticated: false,
  auth,
});

const authenticatedSession = (
  auth: AuthSessionState["auth"],
  scopes?: AuthSessionState["scopes"],
): AuthSessionState => ({
  authenticated: true,
  auth,
  ...(scopes === undefined ? {} : { scopes }),
  sessionMethod: "browser-session-cookie",
  expiresAt: SESSION_EXPIRES_AT,
});

const browserSession = (scopes: AuthBrowserSessionResult["scopes"]): AuthBrowserSessionResult => ({
  authenticated: true,
  scopes,
  sessionMethod: "browser-session-cookie",
  expiresAt: SESSION_EXPIRES_AT,
});

function installTestBrowser(url: string) {
  const values = new Map<string, string>();
  const localStorage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  const testWindow: TestWindow = {
    location: new URL(url),
    localStorage,
    history: {
      replaceState: (_data, _unused, nextUrl) => {
        testWindow.location = new URL(nextUrl, testWindow.location.href);
      },
    },
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "T3 Code" });

  return testWindow;
}

function installDesktopBootstrap() {
  const testWindow = installTestBrowser("http://localhost/");
  testWindow.desktopBridge = {
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        label: "Local environment",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
        bootstrapToken: "desktop-bootstrap-token",
      },
    ],
  } as unknown as DesktopBridge;
}

function installValidAuthenticatedProof(overrides?: Record<string, unknown>) {
  window.localStorage.setItem(
    "t3code:primary-authenticated:v1",
    JSON.stringify({
      version: 1,
      browserOrigin: window.location.origin,
      primaryTargetSignature: `${window.location.origin}/|ws://${window.location.host}/`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...overrides,
    }),
  );
}

function sequence<A>(...values: ReadonlyArray<A>) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

let disposeHttpTest: (() => Promise<void>) | undefined;

async function installAuthApi(input: {
  readonly session?: () => AuthSessionState;
  readonly browserSession?: (
    credential: string,
  ) => Effect.Effect<AuthBrowserSessionResult, EnvironmentAuthInvalidError>;
  readonly pairingCredential?: (payload: AuthCreatePairingCredentialInput) => Effect.Effect<{
    readonly id: string;
    readonly credential: string;
    readonly label?: string;
    readonly expiresAt: DateTime.Utc;
  }>;
}) {
  const testApi = await installEnvironmentHttpTest({
    ...(input.session ? { session: () => Effect.succeed(input.session!()) } : {}),
    ...(input.browserSession
      ? { browserSession: (payload) => input.browserSession!(payload.credential) }
      : {}),
    ...(input.pairingCredential
      ? { pairingCredential: (payload) => input.pairingCredential!(payload) }
      : {}),
  });
  disposeHttpTest = testApi.dispose;
  return testApi;
}

describe("resolveInitialServerAuthGateState", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    await disposeHttpTest?.();
    disposeHttpTest = undefined;
    const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
    __resetServerAuthBootstrapForTests();
    __setPrimaryHttpRunnerForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses an in-flight silent bootstrap attempt", async () => {
    const nextSession = sequence(
      unauthenticatedSession(DESKTOP_AUTH),
      authenticatedSession(DESKTOP_AUTH, AuthAdministrativeScopes),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => Effect.succeed(browserSession(["orchestration:read", "access:write"])),
    });

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          label: "Windows",
          httpBaseUrl: "http://localhost:3773",
          wsBaseUrl: "ws://localhost:3773",
          bootstrapToken: "desktop-bootstrap-token",
        },
      ],
    } as unknown as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await Promise.all([resolveInitialServerAuthGateState(), resolveInitialServerAuthGateState()]);

    expect(testApi.calls.session).toBe(2);
    expect(testApi.calls.browserSession).toEqual([{ credential: "desktop-bootstrap-token" }]);
  });

  it("uses https urls when the primary environment uses wss", async () => {
    await installAuthApi({ session: () => unauthenticatedSession(LOOPBACK_AUTH) });
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { resolveInitialServerAuthGateState, resolvePrimaryEnvironmentHttpUrl } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    expect(resolvePrimaryEnvironmentHttpUrl("/api/auth/session")).toBe(
      "https://remote.example.com/api/auth/session",
    );
  });

  it("uses the current origin as an auth proxy base for local dev environments", async () => {
    await installAuthApi({ session: () => unauthenticatedSession(LOOPBACK_AUTH) });
    installTestBrowser("http://localhost:5735/");

    const { resolveInitialServerAuthGateState, resolvePrimaryEnvironmentHttpUrl } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    expect(resolvePrimaryEnvironmentHttpUrl("/api/auth/session")).toBe(
      "http://localhost:5735/api/auth/session",
    );
  });

  it("uses the vite proxy for desktop-managed loopback auth requests during local dev", async () => {
    await installAuthApi({ session: () => unauthenticatedSession(DESKTOP_AUTH) });
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");

    const testWindow = installTestBrowser("http://127.0.0.1:5733/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          label: "Windows",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        },
      ],
    } as unknown as DesktopBridge;

    const { resolveInitialServerAuthGateState, resolvePrimaryEnvironmentHttpUrl } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: DESKTOP_AUTH,
    });
    expect(resolvePrimaryEnvironmentHttpUrl("/api/auth/session")).toBe(
      "http://127.0.0.1:5733/api/auth/session",
    );
  });

  it("returns a requires-auth state instead of throwing when no bootstrap credential exists", async () => {
    await installAuthApi({ session: () => unauthenticatedSession(LOOPBACK_AUTH) });
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
  });

  it("retries transient auth session bootstrap failures after restart", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = HttpClientRequest.get("http://localhost/api/auth/session");
    const response = HttpClientResponse.fromWeb(
      request,
      new Response("Bad Gateway", { status: 502 }),
    );
    const runner: PrimaryHttpEffectRunner = async <A>() => {
      attempts += 1;
      if (attempts < 4) {
        throw new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({ request, response }),
        });
      }
      return unauthenticatedSession(LOOPBACK_AUTH) as A;
    };
    __setPrimaryHttpRunnerForTests(runner);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(gateStatePromise).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    expect(attempts).toBe(4);
  });

  it("boots a previously authenticated browser from cached state while the primary is offline", async () => {
    vi.useFakeTimers();
    installValidAuthenticatedProof();
    const request = HttpClientRequest.get("http://localhost/api/auth/session");
    const response = HttpClientResponse.fromWeb(
      request,
      new Response("Bad Gateway", { status: 502 }),
    );
    __setPrimaryHttpRunnerForTests(async () => {
      throw new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({ request, response }),
      });
    });

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(gateStatePromise).resolves.toEqual({ status: "offline-authenticated" });
  });

  it("boots cached state immediately after a raw network failure", async () => {
    installValidAuthenticatedProof();
    __setPrimaryHttpRunnerForTests(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "offline-authenticated",
    });
  });

  it("does not let a first-time browser enter cached state on a transient failure", async () => {
    vi.useFakeTimers();
    __setPrimaryHttpRunnerForTests(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    const rejection = expect(gateStatePromise).rejects.toMatchObject({
      _tag: "PrimaryEnvironmentRequestError",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });

  it("rejects expired and target-mismatched authenticated proofs", async () => {
    for (const overrides of [
      { expiresAt: "2000-01-01T00:00:00.000Z" },
      { primaryTargetSignature: "https://different.example/|wss://different.example/" },
    ]) {
      vi.useFakeTimers();
      installValidAuthenticatedProof(overrides);
      __setPrimaryHttpRunnerForTests(async () => {
        throw new TypeError("Failed to fetch");
      });
      const { resolveInitialServerAuthGateState, __resetServerAuthBootstrapForTests } =
        await import("./environments/primary");
      const gateStatePromise = resolveInitialServerAuthGateState();
      const rejection = expect(gateStatePromise).rejects.toMatchObject({
        _tag: "PrimaryEnvironmentRequestError",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      __resetServerAuthBootstrapForTests();
    }
  });

  it.each([401, 403])("never uses cached authentication for HTTP %i", async (status) => {
    installValidAuthenticatedProof();
    const request = HttpClientRequest.get("http://localhost/api/auth/session");
    const response = HttpClientResponse.fromWeb(request, new Response("Denied", { status }));
    __setPrimaryHttpRunnerForTests(async () => {
      throw new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({ request, response }),
      });
    });
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).rejects.toMatchObject({ status });
    expect(window.localStorage.getItem("t3code:primary-authenticated:v1")).toBeNull();
  });

  it("persists only non-secret session metadata after successful authentication", async () => {
    await installAuthApi({ session: () => authenticatedSession(LOOPBACK_AUTH) });
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    const proof = window.localStorage.getItem("t3code:primary-authenticated:v1");
    expect(proof).not.toBeNull();
    expect(JSON.parse(proof!)).toEqual({
      version: 1,
      browserOrigin: "http://localhost",
      primaryTargetSignature: "http://localhost/|ws://localhost/",
      expiresAt: "2026-04-05T00:00:00.000Z",
    });
    expect(proof).not.toMatch(/token|credential|cookie|sessionId/i);
  });

  it("ejects cached authentication when revalidation reports an unauthenticated session", async () => {
    installValidAuthenticatedProof();
    const testApi = await installAuthApi({ session: () => unauthenticatedSession(LOOPBACK_AUTH) });
    const { revalidateOfflineServerAuthGateState, resolveInitialServerAuthGateState } =
      await import("./environments/primary");

    await expect(revalidateOfflineServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    expect(window.localStorage.getItem("t3code:primary-authenticated:v1")).toBeNull();
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    expect(testApi.calls.session).toBe(1);
  });

  it("performs one request per offline revalidation attempt", async () => {
    installValidAuthenticatedProof();
    let attempts = 0;
    __setPrimaryHttpRunnerForTests(async () => {
      attempts += 1;
      throw new TypeError("Failed to fetch");
    });
    const { revalidateOfflineServerAuthGateState } = await import("./environments/primary");

    await expect(revalidateOfflineServerAuthGateState()).rejects.toMatchObject({
      _tag: "PrimaryEnvironmentRequestError",
    });
    expect(attempts).toBe(1);
  });

  it("takes a pairing token from the location hash and strips it immediately", async () => {
    const testWindow = installTestBrowser("http://localhost/#token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.hash).toBe("");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("accepts query-string pairing tokens as a backward-compatible fallback", async () => {
    const testWindow = installTestBrowser("http://localhost/?token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("allows manual token submission after the initial auth check requires pairing", async () => {
    const nextSession = sequence(
      unauthenticatedSession(LOOPBACK_AUTH),
      authenticatedSession(LOOPBACK_AUTH),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => Effect.succeed(browserSession(["orchestration:read"])),
    });
    const { resolveInitialServerAuthGateState, submitServerAuthCredential } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    await expect(submitServerAuthCredential("retry-token")).resolves.toBeUndefined();
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(testApi.calls.browserSession).toEqual([{ credential: "retry-token" }]);
    expect(testApi.calls.session).toBe(2);
  });

  it("rejects a blank pairing token with a structured validation error", async () => {
    const { PrimaryEnvironmentPairingCredentialRequiredError, submitServerAuthCredential } =
      await import("./environments/primary/auth");

    const error = await submitServerAuthCredential("   ").then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(PrimaryEnvironmentPairingCredentialRequiredError);
    expect(error).toMatchObject({
      _tag: "PrimaryEnvironmentPairingCredentialRequiredError",
      providedLength: 3,
      message: "Enter a pairing token to continue.",
    });
  });

  it("surfaces a friendly error message when an invalid pairing token is submitted", async () => {
    const cause = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-invalid-credential",
    });
    const testApi = await installAuthApi({
      browserSession: () => Effect.fail(cause),
    });

    const { isPrimaryEnvironmentPairingCredentialRejectedError, submitServerAuthCredential } =
      await import("./environments/primary");

    const error = await submitServerAuthCredential("bad-token").then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({
      _tag: "PrimaryEnvironmentPairingCredentialRejectedError",
      providedLength: 9,
      message: "Invalid pairing token. Check the token and try again.",
    });
    expect(isPrimaryEnvironmentPairingCredentialRejectedError(error)).toBe(true);
    if (!isPrimaryEnvironmentPairingCredentialRejectedError(error)) {
      throw new Error("Expected a structured rejected pairing credential error.");
    }
    expect(error.cause).toMatchObject({
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-invalid-credential",
    });
    expect(testApi.calls.browserSession).toEqual([{ credential: "bad-token" }]);
  });

  it("derives primary request messages from structural request context", async () => {
    const cause = new Error("private transport detail");
    const { PrimaryEnvironmentRequestError } = await import("./environments/primary");
    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "list-pairing-links",
      cause,
    });

    expect(error.status).toBe(500);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(
      "Primary environment request failed during list-pairing-links (HTTP 500).",
    );
    expect(error.message).not.toContain(cause.message);
  });

  it("waits for the authenticated session to become observable after silent desktop bootstrap", async () => {
    vi.useFakeTimers();
    const nextSession = sequence(
      unauthenticatedSession(DESKTOP_AUTH),
      unauthenticatedSession(DESKTOP_AUTH),
      authenticatedSession(DESKTOP_AUTH, AuthAdministrativeScopes),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => Effect.succeed(browserSession(AuthAdministrativeScopes)),
    });

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          label: "Windows",
          httpBaseUrl: "http://localhost:3773",
          wsBaseUrl: "ws://localhost:3773",
          bootstrapToken: "desktop-bootstrap-token",
        },
      ],
    } as unknown as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(100);

    await expect(gateStatePromise).resolves.toEqual({ status: "authenticated" });
    expect(testApi.calls.session).toBe(3);
  });

  it("refreshes an older desktop session that lacks newly required administrative scopes", async () => {
    const previousAdministrativeScopes = AuthAdministrativeScopes.filter(
      (scope) => scope !== AuthDiagnosticsCaptureScope,
    );
    const testApi = await installAuthApi({
      session: sequence(
        authenticatedSession(DESKTOP_AUTH, previousAdministrativeScopes),
        authenticatedSession(DESKTOP_AUTH, AuthAdministrativeScopes),
      ),
      browserSession: () => Effect.succeed(browserSession(AuthAdministrativeScopes)),
    });
    installDesktopBootstrap();

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(testApi.calls.browserSession).toEqual([{ credential: "desktop-bootstrap-token" }]);
    expect(testApi.calls.session).toBe(2);
  });

  it("preserves the timeout message when a bootstrapped session never becomes observable", async () => {
    vi.useFakeTimers();
    const testApi = await installAuthApi({
      session: () => unauthenticatedSession(DESKTOP_AUTH),
      browserSession: () => Effect.succeed(browserSession(["orchestration:read", "access:write"])),
    });

    installDesktopBootstrap();

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(gateStatePromise).resolves.toEqual({
      status: "requires-auth",
      auth: DESKTOP_AUTH,
      errorMessage: "Timed out waiting for authenticated session after bootstrap.",
    });
    expect(testApi.calls.browserSession).toEqual([{ credential: "desktop-bootstrap-token" }]);
  });

  it("memoizes the authenticated gate state after the first successful read", async () => {
    const testApi = await installAuthApi({
      session: sequence(authenticatedSession(LOOPBACK_AUTH), unauthenticatedSession(LOOPBACK_AUTH)),
    });
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(testApi.calls.session).toBe(1);
  });

  it("creates a pairing credential from the authenticated auth endpoint", async () => {
    const testApi = await installAuthApi({
      pairingCredential: (payload) =>
        Effect.succeed({
          id: "pairing-link-1",
          credential: "pairing-token",
          ...(payload.label === undefined ? {} : { label: payload.label }),
          expiresAt: SESSION_EXPIRES_AT,
        }),
    });
    const { createServerPairingCredential } = await import("./environments/primary");

    const credential = await createServerPairingCredential({
      label: "Julius iPhone",
      scopes: ["orchestration:read"],
    });
    expect(credential).toMatchObject({
      id: "pairing-link-1",
      credential: "pairing-token",
      label: "Julius iPhone",
    });
    expect(DateTime.formatIso(credential.expiresAt)).toBe("2026-04-05T00:00:00.000Z");
    expect(testApi.calls.pairingCredential).toEqual([
      { label: "Julius iPhone", scopes: ["orchestration:read"] },
    ]);
  });
});
