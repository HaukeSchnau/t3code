import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { NEEDS_YOU_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** What each environment alerts about, as it publishes and resolves it (patches/needs-you.md). */
export const needsYouSubjectsAtom = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:needs-you:subjects",
    tag: NEEDS_YOU_WS_METHODS.subscribe,
  },
);
