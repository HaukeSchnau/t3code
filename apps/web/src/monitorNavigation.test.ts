import { assert, beforeEach, describe, it } from "vite-plus/test";

import {
  appHrefFromLocation,
  rememberMonitorReturnLocation,
  resetMonitorReturnLocationForTest,
  resolveMonitorToggleTarget,
} from "./monitorNavigation";

describe("monitor navigation", () => {
  beforeEach(() => {
    resetMonitorReturnLocationForTest();
  });

  it("builds app hrefs with search and hash", () => {
    assert.equal(
      appHrefFromLocation({
        pathname: "/settings/keybindings",
        searchStr: "?q=monitor",
        hash: "#shortcuts",
      }),
      "/settings/keybindings?q=monitor#shortcuts",
    );
  });

  it("opens monitor from non-monitor routes", () => {
    assert.deepEqual(resolveMonitorToggleTarget("/settings"), {
      to: "/monitor",
      replace: false,
    });
  });

  it("returns from monitor to the last non-monitor route", () => {
    rememberMonitorReturnLocation({
      pathname: "/settings/keybindings",
      searchStr: "?q=monitor",
      hash: "#shortcuts",
    });

    assert.deepEqual(resolveMonitorToggleTarget("/monitor"), {
      to: "/settings/keybindings?q=monitor#shortcuts",
      replace: true,
    });
  });

  it("falls back home when monitor has no remembered return route", () => {
    assert.deepEqual(resolveMonitorToggleTarget("/monitor"), {
      to: "/",
      replace: true,
    });
  });

  it("does not remember monitor as its own return route", () => {
    rememberMonitorReturnLocation({ pathname: "/settings" });
    rememberMonitorReturnLocation({ pathname: "/monitor" });

    assert.deepEqual(resolveMonitorToggleTarget("/monitor"), {
      to: "/settings",
      replace: true,
    });
  });
});
