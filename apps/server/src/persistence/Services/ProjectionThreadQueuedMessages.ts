import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationNotificationOrigin,
  OrchestrationProposedPlanId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadQueuedMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  origin: Schema.NullOr(OrchestrationNotificationOrigin),
  modelSelection: Schema.NullOr(ModelSelection),
  titleSeed: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadQueuedMessage = typeof ProjectionThreadQueuedMessage.Type;

export const ListProjectionThreadQueuedMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadQueuedMessagesInput =
  typeof ListProjectionThreadQueuedMessagesInput.Type;

export const GetProjectionThreadQueuedMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadQueuedMessageInput =
  typeof GetProjectionThreadQueuedMessageInput.Type;

export const DeleteProjectionThreadQueuedMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type DeleteProjectionThreadQueuedMessageInput =
  typeof DeleteProjectionThreadQueuedMessageInput.Type;

export const DeleteProjectionThreadQueuedMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadQueuedMessagesInput =
  typeof DeleteProjectionThreadQueuedMessagesInput.Type;

export interface ProjectionThreadQueuedMessageRepositoryShape {
  readonly upsert: (
    message: ProjectionThreadQueuedMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getByMessageId: (
    input: GetProjectionThreadQueuedMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadQueuedMessage>, ProjectionRepositoryError>;

  readonly listByThreadId: (
    input: ListProjectionThreadQueuedMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadQueuedMessage>, ProjectionRepositoryError>;

  readonly deleteByMessageId: (
    input: DeleteProjectionThreadQueuedMessageInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly deleteByThreadId: (
    input: DeleteProjectionThreadQueuedMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadQueuedMessageRepository extends Context.Service<
  ProjectionThreadQueuedMessageRepository,
  ProjectionThreadQueuedMessageRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadQueuedMessages/ProjectionThreadQueuedMessageRepository",
) {}
