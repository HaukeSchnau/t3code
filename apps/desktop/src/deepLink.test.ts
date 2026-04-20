import { describe, expect, it } from "vitest";

import { parseDesktopDeepLink } from "./deepLink.ts";

describe("parseDesktopDeepLink", () => {
  it("parses workspace open requests from the protocol host", () => {
    expect(parseDesktopDeepLink("t3://open?cwd=/Users/dev/t3code")).toEqual({
      cwd: "/Users/dev/t3code",
    });
  });

  it("parses workspace open requests from the protocol path", () => {
    expect(parseDesktopDeepLink("t3:///open?cwd=%2FUsers%2Fdev%2Fwith%20spaces")).toEqual({
      cwd: "/Users/dev/with spaces",
    });
  });

  it("ignores unsupported actions and malformed requests", () => {
    expect(parseDesktopDeepLink("t3://settings")).toBeNull();
    expect(parseDesktopDeepLink("t3://open")).toBeNull();
    expect(parseDesktopDeepLink("not-a-url")).toBeNull();
  });
});
