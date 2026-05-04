import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface JjTurnChangeTrackerShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class JjTurnChangeTracker extends Context.Service<
  JjTurnChangeTracker,
  JjTurnChangeTrackerShape
>()("t3/orchestration/Services/JjTurnChangeTracker") {}
