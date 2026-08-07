import * as Layer from "effect/Layer";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotMaterializerLive } from "./Layers/ProjectionSnapshotMaterializer.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

const OrchestrationRuntimeStateLayerLive = Layer.merge(
  ThreadBackgroundLiveness.layer,
  ThreadPlanProgress.layer,
);

const OrchestrationInfrastructureCoreLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationProjectionSnapshotMaterializerLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  ),
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

// Shared in-memory registries are supplied once to readers in the core and
// re-exported for runtime ingestion, guaranteeing both sides see one instance.
export const OrchestrationInfrastructureLayerLive = Layer.merge(
  OrchestrationRuntimeStateLayerLive,
  OrchestrationInfrastructureCoreLayerLive.pipe(Layer.provide(OrchestrationRuntimeStateLayerLive)),
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);
