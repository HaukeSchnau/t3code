import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class JjAutomaticChangeService extends Context.Service<
  JjAutomaticChangeService,
  {
    readonly beforeTurn: (input: {
      readonly threadId: string;
      readonly cwd: string;
    }) => Effect.Effect<void>;
    readonly afterTurn: (input: {
      readonly threadId: string;
      readonly cwd: string;
      readonly summary: string;
    }) => Effect.Effect<void>;
  }
>()("t3/workspace/JjAutomaticChangeService") {}

export const make = Effect.succeed(
  JjAutomaticChangeService.of({
    beforeTurn: () => Effect.void,
    afterTurn: () => Effect.void,
  }),
);

export const layer = Layer.effect(JjAutomaticChangeService, make);
