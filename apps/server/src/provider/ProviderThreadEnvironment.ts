import { ProviderThreadEnvironment } from "@t3tools/provider-core/server/threadEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JjThreadLayer } from "../jj/JjThreadLayer.ts";
import { withOpenCodeSkillPacks } from "../skills/SkillPackProviderScope.ts";

/** Gives per-thread provider processes the thread's jj layer and OpenCode its skill packs. */
export const layer = Layer.effect(
  ProviderThreadEnvironment,
  Effect.gen(function* () {
    const threadLayer = yield* JjThreadLayer;
    return {
      forThread: threadLayer.environmentFor,
      forOpenCodeServer: (threadId, environment) =>
        threadLayer
          .environmentFor(threadId)
          .pipe(
            Effect.map((threadEnvironment) =>
              withOpenCodeSkillPacks(threadId, { ...environment, ...threadEnvironment }),
            ),
          ),
    };
  }),
);
