import {
  ChatAttachment,
  ModelSelection,
  OrchestrationNotificationOrigin,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadQueuedMessageInput,
  DeleteProjectionThreadQueuedMessagesInput,
  GetProjectionThreadQueuedMessageInput,
  ListProjectionThreadQueuedMessagesInput,
  ProjectionThreadQueuedMessage,
  ProjectionThreadQueuedMessageRepository,
  type ProjectionThreadQueuedMessageRepositoryShape,
} from "../Services/ProjectionThreadQueuedMessages.ts";

const ProjectionThreadQueuedMessageDbRowSchema = ProjectionThreadQueuedMessage.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    origin: Schema.NullOr(Schema.fromJsonString(OrchestrationNotificationOrigin)),
  }),
);

const makeProjectionThreadQueuedMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadQueuedMessageRow = SqlSchema.void({
    Request: ProjectionThreadQueuedMessage,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_queued_messages (
          message_id,
          thread_id,
          text,
          attachments_json,
          origin_json,
          model_selection_json,
          title_seed,
          runtime_mode,
          interaction_mode,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.text},
          ${JSON.stringify(row.attachments)},
          ${row.origin === null ? null : JSON.stringify(row.origin)},
          ${row.modelSelection === null ? null : JSON.stringify(row.modelSelection)},
          ${row.titleSeed},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          text = excluded.text,
          attachments_json = excluded.attachments_json,
          origin_json = excluded.origin_json,
          model_selection_json = excluded.model_selection_json,
          title_seed = excluded.title_seed,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadQueuedMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadQueuedMessageInput,
    Result: ProjectionThreadQueuedMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          text,
          attachments_json AS "attachments",
          origin_json AS "origin",
          model_selection_json AS "modelSelection",
          title_seed AS "titleSeed",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_queued_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadQueuedMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadQueuedMessagesInput,
    Result: ProjectionThreadQueuedMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          text,
          attachments_json AS "attachments",
          origin_json AS "origin",
          model_selection_json AS "modelSelection",
          title_seed AS "titleSeed",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_queued_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const deleteProjectionThreadQueuedMessageRow = SqlSchema.void({
    Request: DeleteProjectionThreadQueuedMessageInput,
    execute: ({ messageId }) =>
      sql`
        DELETE FROM projection_thread_queued_messages
        WHERE message_id = ${messageId}
      `,
  });

  const deleteProjectionThreadQueuedMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadQueuedMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_queued_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadQueuedMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadQueuedMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadQueuedMessageRepository.upsert")),
    );

  const getByMessageId: ProjectionThreadQueuedMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadQueuedMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedMessageRepository.getByMessageId"),
      ),
      Effect.map(Option.map((row) => row)),
    );

  const listByThreadId: ProjectionThreadQueuedMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadQueuedMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedMessageRepository.listByThreadId"),
      ),
      Effect.map((rows) => rows.map((row) => row)),
    );

  const deleteByMessageId: ProjectionThreadQueuedMessageRepositoryShape["deleteByMessageId"] = (
    input,
  ) =>
    deleteProjectionThreadQueuedMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedMessageRepository.deleteByMessageId"),
      ),
    );

  const deleteByThreadId: ProjectionThreadQueuedMessageRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadQueuedMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedMessageRepository.deleteByThreadId"),
      ),
    );

  return {
    upsert,
    getByMessageId,
    listByThreadId,
    deleteByMessageId,
    deleteByThreadId,
  } satisfies ProjectionThreadQueuedMessageRepositoryShape;
});

export const ProjectionThreadQueuedMessageRepositoryLive = Layer.effect(
  ProjectionThreadQueuedMessageRepository,
  makeProjectionThreadQueuedMessageRepository,
);
