import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildDirectHostedPairingUrl,
  buildHostedChannelSelectionUrl,
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  isHostedPairingBrowserNetworkDenied,
  isHostedStaticApp,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.t3.codes/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
      environmentId: null,
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
        environmentId: "environment-123",
      }),
    );

    expect(url.origin).toBe("https://preview.t3.codes");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("environmentId")).toBe("environment-123");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("builds direct backend pairing URLs for hosted fallbacks", () => {
    const url = new URL(
      buildDirectHostedPairingUrl({
        host: "t3.schnau.dev",
        token: "pairing-token",
      }) ?? "",
    );

    expect(url.origin).toBe("https://t3.schnau.dev");
    expect(url.pathname).toBe("/pair");
    expect(url.search).toBe("");
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("detects browser local-network policy denial errors", () => {
    const error = new Error("Pairing failed.", {
      cause: new Error(
        "Access to fetch at 'https://t3.schnau.dev/.well-known/t3/environment' was blocked: LocalNetworkAccessPermissionDenied",
      ),
    });

    expect(isHostedPairingBrowserNetworkDenied(error)).toBe(true);
    expect(isHostedPairingBrowserNetworkDenied(new Error("The server returned 500."))).toBe(false);
  });

  it("builds hosted channel selection URLs through the configured router origin", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    const url = new URL(
      buildHostedChannelSelectionUrl({
        channel: "nightly",
      }),
    );

    expect(url.origin).toBe("https://app.t3.codes");
    expect(url.pathname).toBe("/__t3code/channel");
    expect(url.searchParams.get("channel")).toBe("nightly");
    expect(url.searchParams.has("next")).toBe(false);
  });

  it("ignores incomplete hosted pairing requests", () => {
    expect(
      hasHostedPairingRequest(new URL("https://app.t3.codes/pair?host=backend.example.com")),
    ).toBe(false);
    expect(hasHostedPairingRequest(new URL("https://app.t3.codes/pair?token=ABCD1234"))).toBe(
      false,
    );
  });

  it("detects the hosted static app only when no backend URL is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://preview.t3.codes/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://preview.t3.codes/pair"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://backend.example.com/"))).toBe(false);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://preview.t3.codes/"))).toBe(false);
  });

  it("detects hosted channel aliases as static apps", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://nightly.app.t3.codes/"))).toBe(true);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://nightly.app.t3.codes/"))).toBe(false);
  });
});
