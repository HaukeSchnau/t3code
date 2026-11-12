import { makeHtmlRenderStateStore } from "@t3tools/client-runtime/html-render/state-store";
import { createHtmlRenderEnvironmentAtoms } from "@t3tools/client-runtime/state/html-render";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const htmlRenderEnvironment = createHtmlRenderEnvironmentAtoms(connectionAtomRuntime);

export const htmlRenderStateStore = makeHtmlRenderStateStore({
  write: async ({ environmentId, threadId, renderId }, state) =>
    (
      await runAtomCommand(
        appAtomRegistry,
        htmlRenderEnvironment.setState,
        { environmentId, input: { threadId, renderId, state } },
        { reportFailure: false },
      )
    )._tag === "Success",
});

// A closing or hidden tab may never come back to send what its pages saved.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => htmlRenderStateStore.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") htmlRenderStateStore.flush();
  });
}
