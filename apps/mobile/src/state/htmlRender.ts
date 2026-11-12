import { makeHtmlRenderStateStore } from "@t3tools/client-runtime/html-render/state-store";
import { createHtmlRenderEnvironmentAtoms } from "@t3tools/client-runtime/state/html-render";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

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

// iOS may end the app or its WebViews once it leaves the foreground.
AppState.addEventListener("change", (state) => {
  if (state !== "active") htmlRenderStateStore.flush();
});
