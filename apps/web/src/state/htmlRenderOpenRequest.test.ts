import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { registerHtmlRenderOpener, requestHtmlRenderOpen } from "./htmlRenderOpenRequest";

it("opens the frame registered when a waiting request runs", async () => {
  const target = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    renderId: "render",
  };
  requestHtmlRenderOpen(target);
  const unmounted = vi.fn();
  const remounted = vi.fn();
  registerHtmlRenderOpener(target, unmounted)();
  const unregister = registerHtmlRenderOpener(target, remounted);
  await Promise.resolve();
  expect(unmounted).not.toHaveBeenCalled();
  expect(remounted).toHaveBeenCalledOnce();
  unregister();
});
