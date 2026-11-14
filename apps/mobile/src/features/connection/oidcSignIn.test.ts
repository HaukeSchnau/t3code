import { describe, expect, it, vi } from "vite-plus/test";

const browser = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: browser.open }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "t3code" } } }));
vi.mock("expo-crypto", () => ({
  getRandomBytes: (count: number) => Uint8Array.from({ length: count }, (_, index) => index),
}));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("../../connection/onboarding", () => ({
  readOidcSignInOffer: {},
  resolvePeerSignIn: {},
  runPeerFanOut: {},
}));
vi.mock("../../lib/protectedData", () => ({ whenProtectedDataAvailable: vi.fn() }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/presentation", () => ({ connectedEnvironmentIdsAtom: {} }));
vi.mock("../../state/use-remote-environment-registry", () => ({ pairEnvironment: vi.fn() }));

import { signInWithOidc } from "./oidcSignIn";

const ORIGIN = "https://box.example.test";

/** The sheet ends at the URL `build` makes from the start URL the app opened. */
const sheetReturns = (build: (start: URL) => string) =>
  browser.open.mockImplementationOnce(async (url: string) => ({
    type: "success",
    url: build(new URL(url)),
  }));

describe("signInWithOidc", () => {
  it("accepts only a result that brings this attempt's client state back", async () => {
    sheetReturns(
      (start) =>
        `t3code://oidc?host=${encodeURIComponent(ORIGIN)}#token=CODE&client_state=${start.searchParams.get("client_state")}`,
    );
    expect(await signInWithOidc(ORIGIN)).toEqual({ _tag: "Signed", pairingCode: "CODE" });

    // What another app could fire at the scheme: a real grant, without this attempt's value.
    sheetReturns(() => `t3code://oidc?host=${encodeURIComponent(ORIGIN)}#token=OTHER`);
    expect(await signInWithOidc(ORIGIN)).toEqual({ _tag: "Failed", error: "sign_in_failed" });
  });

  it("opens a sign-in started while another sheet is up once that sheet closes", async () => {
    // Like both platforms: a second sheet is refused while one is open.
    let open = false;
    let closeFirst = () => {};
    const sheet = (wait: Promise<void>) => async (url: string) => {
      if (open) throw new Error("Another web browser is already open");
      open = true;
      await wait;
      open = false;
      const start = new URL(url);
      return {
        type: "success",
        url: `t3code://oidc?host=${encodeURIComponent(ORIGIN)}#token=CODE&client_state=${start.searchParams.get("client_state")}`,
      };
    };
    browser.open
      .mockImplementationOnce(sheet(new Promise<void>((resolve) => (closeFirst = resolve))))
      .mockImplementationOnce(sheet(Promise.resolve()));

    const manual = signInWithOidc(ORIGIN);
    const fanOut = signInWithOidc(ORIGIN, { prompt: "none" });
    closeFirst();

    expect(await manual).toEqual({ _tag: "Signed", pairingCode: "CODE" });
    expect(await fanOut).toEqual({ _tag: "Signed", pairingCode: "CODE" });
  });

  it("fails instead of throwing when no browser can show the sheet", async () => {
    browser.open.mockRejectedValueOnce(new Error("No browser activity"));
    expect(await signInWithOidc(ORIGIN)).toEqual({ _tag: "Failed", error: "browser_unavailable" });
  });
});
