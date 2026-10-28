import { describe, expect, it } from "@effect/vitest";

import { resolveConnectionPairingAutomation } from "./connectionPairingAutomation";

describe("connection pairing automation", () => {
  it("uses the development pairing URL and numeric auto-connect flag", () => {
    expect(
      resolveConnectionPairingAutomation({
        developmentPairingUrl: " https://development.example/pair#token=development ",
        developmentAutoConnect: "1",
      }),
    ).toEqual({
      pairingUrl: "https://development.example/pair#token=development",
      autoConnect: true,
    });
  });

  it("prefills without connecting when the flag is unset", () => {
    expect(
      resolveConnectionPairingAutomation({
        developmentPairingUrl: "https://development.example/pair#token=development",
      }),
    ).toEqual({
      pairingUrl: "https://development.example/pair#token=development",
      autoConnect: false,
    });
  });

  it("does not activate without a pairing URL", () => {
    expect(resolveConnectionPairingAutomation({ developmentAutoConnect: "1" })).toBeNull();
  });
});
