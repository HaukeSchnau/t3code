import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createHtmlRenderEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Read fresh on every mount: another device may have written since. */
    stateQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:html-render:state",
      tag: WS_METHODS.htmlRenderGetState,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:html-render:set-state",
      tag: WS_METHODS.htmlRenderSetState,
    }),
    callTool: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:html-render:call-tool",
      tag: WS_METHODS.htmlRenderCallTool,
    }),
  };
}
