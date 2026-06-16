import "../../index.css";

import type { EnvironmentApi } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";

import { PreviewAutomationOwner } from "./PreviewAutomationOwner";

const ENVIRONMENT_ID = EnvironmentId.make("environment-preview-owner");
const THREAD_ID = ThreadId.make("thread-preview-owner");

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
});

describe("PreviewAutomationOwner", () => {
  it("does not clear and reclaim the same owner on equivalent rerenders", async () => {
    const disconnect = vi.fn();
    const connect = vi.fn(() => disconnect);
    const reportOwner = vi.fn(() => Promise.resolve());
    const clearOwner = vi.fn(() => Promise.resolve());

    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      preview: {
        automation: {
          connect,
          reportOwner,
          clearOwner,
          respond: vi.fn(),
        },
      },
    } as unknown as EnvironmentApi);

    const screen = await render(
      <PreviewAutomationOwner
        threadRef={{ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }}
        visible
      />,
    );

    await vi.waitFor(() => {
      expect(reportOwner).toHaveBeenCalledTimes(1);
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clearOwner).not.toHaveBeenCalled();

    await screen.rerender(
      <PreviewAutomationOwner
        threadRef={{ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }}
        visible
      />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(reportOwner).toHaveBeenCalledTimes(1);
    expect(clearOwner).not.toHaveBeenCalled();

    await screen.rerender(
      <PreviewAutomationOwner
        threadRef={{ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }}
        visible={false}
      />,
    );

    await vi.waitFor(() => {
      expect(reportOwner).toHaveBeenCalledTimes(2);
    });
    expect(clearOwner).not.toHaveBeenCalled();

    await screen.unmount();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(clearOwner).toHaveBeenCalledTimes(1);
  });
});
