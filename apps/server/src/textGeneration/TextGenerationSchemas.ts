import * as Schema from "effect/Schema";

export const WatchDecisionGenerationResult = Schema.Struct({
  action: Schema.Literals(["ignore", "wake", "close"]),
  summary: Schema.String,
});
export type WatchDecisionGenerationResult = typeof WatchDecisionGenerationResult.Type;

export const WaitSummaryGenerationResult = Schema.Struct({
  summary: Schema.String,
  failures: Schema.Array(Schema.String),
  disagreements: Schema.Array(Schema.String),
  recommendedNextStep: Schema.String,
});
export type WaitSummaryGenerationResult = typeof WaitSummaryGenerationResult.Type;
