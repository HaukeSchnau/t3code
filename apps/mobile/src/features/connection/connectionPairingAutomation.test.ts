import { describe, expect, it } from "@effect/vitest";

import { resolveConnectionPairingAutomation } from "./connectionPairingAutomation";

describe("connection pairing automation", () => {
  it("prefers an explicit deep-link pairing URL and auto-connect flag", () => {
    expect(
      resolveConnectionPairingAutomation({
        routePairingUrl: " https://route.example/pair#token=route ",
        routeAutoConnect: "true",
        developmentPairingUrl: "https://development.example/pair#token=development",
      }),
    ).toEqual({
      pairingUrl: "https://route.example/pair#token=route",
      autoConnect: true,
    });
  });

  it("uses the development pairing URL and numeric auto-connect flag", () => {
    expect(
      resolveConnectionPairingAutomation({
        developmentPairingUrl: "https://development.example/pair#token=development",
        developmentAutoConnect: "1",
      }),
    ).toEqual({
      pairingUrl: "https://development.example/pair#token=development",
      autoConnect: true,
    });
  });

  it("does not activate without a pairing URL", () => {
    expect(
      resolveConnectionPairingAutomation({
        routeAutoConnect: "true",
        developmentAutoConnect: "1",
      }),
    ).toBeNull();
  });
});
