import { createHtmlRenderEnvironmentAtoms } from "@t3tools/client-runtime/state/html-render";

import { connectionAtomRuntime } from "../connection/runtime";

export const htmlRenderEnvironment = createHtmlRenderEnvironmentAtoms(connectionAtomRuntime);
