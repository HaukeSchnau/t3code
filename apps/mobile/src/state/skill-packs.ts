import { createSkillPackEnvironmentAtoms } from "@t3tools/client-runtime/state/skill-packs";

import { connectionAtomRuntime } from "../connection/runtime";

/** Fork: skill packs (patches/skill-packs.md). */
export const skillPackEnvironment = createSkillPackEnvironmentAtoms(connectionAtomRuntime);
