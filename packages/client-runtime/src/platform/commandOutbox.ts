import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DurableCommandOutboxDocument } from "../operations/commandOutbox.ts";

export class CommandOutboxStorageError extends Schema.TaggedErrorClass<CommandOutboxStorageError>()(
  "CommandOutboxStorageError",
  {
    operation: Schema.Literals(["load", "save"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Platform adapters own serialization and must replace the complete document
 * atomically. The shared outbox never assumes IndexedDB, files, React, or any
 * other platform runtime.
 */
export class CommandOutboxStorage extends Context.Service<
  CommandOutboxStorage,
  {
    readonly load: Effect.Effect<DurableCommandOutboxDocument, CommandOutboxStorageError>;
    readonly save: (
      document: DurableCommandOutboxDocument,
    ) => Effect.Effect<void, CommandOutboxStorageError>;
  }
>()("@t3tools/client-runtime/platform/commandOutbox/CommandOutboxStorage") {}
