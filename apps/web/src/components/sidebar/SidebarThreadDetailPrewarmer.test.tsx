import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { useEnvironmentThreadMount } = vi.hoisted(() => ({
  useEnvironmentThreadMount: vi.fn(() => undefined),
}));

vi.mock("../../state/threads", () => ({ useEnvironmentThreadMount }));

import { SidebarThreadDetailPrewarmer } from "./SidebarThreadDetailPrewarmer";

describe("SidebarThreadDetailPrewarmer", () => {
  afterEach(() => {
    useEnvironmentThreadMount.mockClear();
  });

  it("prewarms only the first two scoped thread refs, in order", () => {
    renderToStaticMarkup(
      <SidebarThreadDetailPrewarmer
        threadKeys={[
          "environment-a:thread-1",
          "environment-b:thread-2",
          "environment-c:thread-3",
          "environment-d:thread-4",
        ]}
      />,
    );

    expect(useEnvironmentThreadMount.mock.calls).toEqual([
      ["environment-a", "thread-1"],
      ["environment-b", "thread-2"],
    ]);
    expect(useEnvironmentThreadMount).toHaveBeenCalledTimes(2);
  });

  it("ignores an invalid key inside the bounded prewarm window", () => {
    renderToStaticMarkup(
      <SidebarThreadDetailPrewarmer
        threadKeys={[
          "environment-a:thread-1",
          "invalid",
          "environment-c:thread-3",
          "environment-d:thread-4",
        ]}
      />,
    );

    expect(useEnvironmentThreadMount.mock.calls).toEqual([["environment-a", "thread-1"]]);
  });
});
