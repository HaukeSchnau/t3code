import { SKILL_PACK_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Fork: skill pack state and edits for one environment (patches/skill-packs.md). */
export function createSkillPackEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** The project's default packs and, when named, one thread's scope. */
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:skill-packs:state",
      tag: SKILL_PACK_WS_METHODS.subscribe,
      idleTtlMs: 30_000,
    }),
    setThreadPacks: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skill-packs:set-thread",
      tag: SKILL_PACK_WS_METHODS.setThreadPacks,
    }),
    setProjectDefault: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skill-packs:set-project-default",
      tag: SKILL_PACK_WS_METHODS.setProjectDefault,
    }),
  };
}
