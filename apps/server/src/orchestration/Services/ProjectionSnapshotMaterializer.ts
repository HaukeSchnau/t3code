import type {
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadActivityDetailMode,
  OrchestrationThreadDetailWindow,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotMaterializerShape {
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
    activityDetailMode?: OrchestrationThreadActivityDetailMode,
    window?: OrchestrationThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/** Server-scoped, cancellation-safe coalescing for concurrent projection snapshots. */
export class ProjectionSnapshotMaterializer extends Context.Service<
  ProjectionSnapshotMaterializer,
  ProjectionSnapshotMaterializerShape
>()("t3/orchestration/Services/ProjectionSnapshotMaterializer") {}
