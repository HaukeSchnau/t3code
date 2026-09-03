import {
  IsoDateTime,
  OrchestrationUsageLimitHistoryWindow,
  OrchestrationUsageLimitsSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProviderUsageLimits = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  usageLimits: OrchestrationUsageLimitsSnapshot,
  history: Schema.Array(OrchestrationUsageLimitHistoryWindow),
  updatedAt: IsoDateTime,
});
export type ProjectionProviderUsageLimits = typeof ProjectionProviderUsageLimits.Type;

export const UpsertProjectionProviderUsageLimits = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  usageLimits: OrchestrationUsageLimitsSnapshot,
  updatedAt: IsoDateTime,
});
export type UpsertProjectionProviderUsageLimits = typeof UpsertProjectionProviderUsageLimits.Type;

export const GetProjectionProviderUsageLimitsInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type GetProjectionProviderUsageLimitsInput =
  typeof GetProjectionProviderUsageLimitsInput.Type;

export interface ProjectionProviderUsageLimitsRepositoryShape {
  readonly upsert: (
    row: UpsertProjectionProviderUsageLimits,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByProviderInstanceId: (
    input: GetProjectionProviderUsageLimitsInput,
  ) => Effect.Effect<Option.Option<ProjectionProviderUsageLimits>, ProjectionRepositoryError>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProjectionProviderUsageLimits>,
    ProjectionRepositoryError
  >;
}

export class ProjectionProviderUsageLimitsRepository extends Context.Service<
  ProjectionProviderUsageLimitsRepository,
  ProjectionProviderUsageLimitsRepositoryShape
>()(
  "t3/persistence/Services/ProjectionProviderUsageLimits/ProjectionProviderUsageLimitsRepository",
) {}
