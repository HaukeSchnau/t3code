import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  decodeDurableCommandOutboxDocument,
  EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT,
  encodeDurableCommandOutboxDocument,
  type DurableCommandOutboxDocument,
} from "@t3tools/client-runtime/operations/command-outbox";
import * as Schema from "effect/Schema";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./thread-outbox-model";

const THREAD_OUTBOX_DIRECTORY = "thread-outbox";
const COMMAND_OUTBOX_FILE = "command-outbox.json";
const COMMAND_OUTBOX_GENERATION_PREFIX = "command-outbox.";
const COMMAND_OUTBOX_MANIFEST_FILE = "command-outbox.manifest.json";
let commandOutboxSaveQueue: Promise<void> = Promise.resolve();

function generationFileName(sequence: number): string {
  return `${COMMAND_OUTBOX_GENERATION_PREFIX}${sequence.toString().padStart(16, "0")}.json`;
}

function generationSequence(fileName: string): number | null {
  const match = /^command-outbox\.(\d{16})\.json$/.exec(fileName);
  return match ? Number(match[1]) : null;
}

export function nextCommandOutboxGenerationSequence(
  fileNames: ReadonlyArray<string>,
  manifestSequence = 0,
): number {
  return (
    Math.max(manifestSequence, ...fileNames.map((name) => generationSequence(name) ?? 0)) + 1
  );
}

export class ThreadOutboxStorageError extends Schema.TaggedErrorClass<ThreadOutboxStorageError>()(
  "ThreadOutboxStorageError",
  {
    operation: Schema.Literals(["load", "read-message", "write", "remove"]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    fileName: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox storage operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}, file ${this.fileName ?? "unknown"}.`;
  }
}

export interface ThreadOutboxStorage {
  readonly load: () => Promise<ReadonlyArray<QueuedThreadMessage>>;
  readonly write: (message: QueuedThreadMessage) => Promise<void>;
  readonly remove: (message: QueuedThreadMessage) => Promise<void>;
  readonly loadCommandOutbox?: () => Promise<DurableCommandOutboxDocument>;
  readonly saveCommandOutbox?: (document: DurableCommandOutboxDocument) => Promise<void>;
}

function messageFileName(messageId: MessageId): string {
  return `${encodeURIComponent(messageId)}.json`;
}

async function getOutboxDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, THREAD_OUTBOX_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function getMessageFile(messageId: MessageId) {
  const { File } = await import("expo-file-system");
  return new File(await getOutboxDirectory(), messageFileName(messageId));
}

export const expoThreadOutboxStorage: ThreadOutboxStorage = {
  loadCommandOutbox: async () => {
    try {
      const { File } = await import("expo-file-system");
      const directory = await getOutboxDirectory();
      const manifest = new File(directory, COMMAND_OUTBOX_MANIFEST_FILE);
      if (manifest.exists) {
        try {
          const value = JSON.parse(await manifest.text()) as {
            version?: unknown;
            sequence?: unknown;
            fileName?: unknown;
          };
          if (
            value.version !== 1 ||
            typeof value.sequence !== "number" ||
            typeof value.fileName !== "string" ||
            value.fileName !== generationFileName(value.sequence)
          ) {
            throw new Error("Invalid command outbox manifest");
          }
          const authoritative = new File(directory, value.fileName);
          return decodeDurableCommandOutboxDocument(
            JSON.parse(await authoritative.text()) as unknown,
          );
        } catch (cause) {
          // The manifest sequence is the high-water mark. Falling back to an
          // older lifecycle after its authoritative removal generation is
          // corrupt could resurrect acknowledged or discarded commands.
          console.warn("[thread-outbox] rebuilding corrupt authoritative command outbox", cause);
          return EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
        }
      }
      const candidates = directory
        .list()
        .filter(
          (entry): entry is InstanceType<typeof File> =>
            entry instanceof File &&
            (entry.name === COMMAND_OUTBOX_FILE ||
              generationSequence(entry.name) !== null),
        )
        .sort((left, right) => {
          if (left.name === COMMAND_OUTBOX_FILE) return 1;
          if (right.name === COMMAND_OUTBOX_FILE) return -1;
          return right.name.localeCompare(left.name);
        });
      for (const file of candidates) {
        try {
          return decodeDurableCommandOutboxDocument(JSON.parse(await file.text()) as unknown);
        } catch (cause) {
          console.warn("[thread-outbox] ignored corrupt command outbox generation", {
            fileName: file.name,
            cause,
          });
        }
      }
      return EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "load",
        environmentId: null,
        threadId: null,
        messageId: null,
        fileName: COMMAND_OUTBOX_FILE,
        cause,
      });
    }
  },
  saveCommandOutbox: (document) => {
    const save = commandOutboxSaveQueue.then(async () => {
      try {
      const { File } = await import("expo-file-system");
      const directory = await getOutboxDirectory();
      const manifest = new File(directory, COMMAND_OUTBOX_MANIFEST_FILE);
      let previousSequence = 0;
      if (manifest.exists) {
        try {
          const value = JSON.parse(await manifest.text()) as { sequence?: unknown };
          if (typeof value.sequence === "number") previousSequence = value.sequence;
        } catch {
          // Recover the high-water value from immutable generation names.
        }
      }
      const sequence = nextCommandOutboxGenerationSequence(
        directory.list().filter((entry) => entry instanceof File).map((entry) => entry.name),
        previousSequence,
      );
      const generation = generationFileName(sequence);
      const destination = new File(directory, generation);
      const temporary = new File(directory, `${generation}.tmp`);
      temporary.create({ intermediates: true, overwrite: true });
      temporary.write(JSON.stringify(encodeDurableCommandOutboxDocument(document)));
      await temporary.move(destination, { overwrite: false });

      const manifestTemporary = new File(directory, `${COMMAND_OUTBOX_MANIFEST_FILE}.tmp`);
      manifestTemporary.create({ intermediates: true, overwrite: true });
      manifestTemporary.write(JSON.stringify({ version: 1, sequence, fileName: generation }));
      await manifestTemporary.move(manifest, { overwrite: true });

      // Keep multiple immutable generations so a corrupt newest record can
      // fall back to the prior complete lifecycle snapshot.
      const older = directory
        .list()
        .filter(
          (entry): entry is InstanceType<typeof File> =>
            entry instanceof File &&
            generationSequence(entry.name) !== null &&
            entry.name !== generation,
        )
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(2);
      for (const file of older) file.delete();
      } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "write",
        environmentId: null,
        threadId: null,
        messageId: null,
        fileName: COMMAND_OUTBOX_FILE,
        cause,
      });
      }
    });
    commandOutboxSaveQueue = save.catch(() => undefined);
    return save;
  },
  load: async () => {
    const messages: QueuedThreadMessage[] = [];
    try {
      const { File } = await import("expo-file-system");
      const directory = await getOutboxDirectory();

      for (const entry of directory.list()) {
        if (
          !(entry instanceof File) ||
          !entry.name.endsWith(".json") ||
          entry.name === COMMAND_OUTBOX_FILE ||
          entry.name.startsWith(COMMAND_OUTBOX_GENERATION_PREFIX)
        ) {
          continue;
        }
        try {
          messages.push(decodeQueuedThreadMessage(JSON.parse(await entry.text()) as unknown));
        } catch (cause) {
          console.warn(
            "[thread-outbox] ignored invalid persisted message",
            new ThreadOutboxStorageError({
              operation: "read-message",
              environmentId: null,
              threadId: null,
              messageId: null,
              fileName: entry.name,
              cause,
            }),
          );
        }
      }
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "load",
        environmentId: null,
        threadId: null,
        messageId: null,
        fileName: null,
        cause,
      });
    }
    return messages;
  },
  write: async (message) => {
    const fileName = messageFileName(message.messageId);
    try {
      const file = await getMessageFile(message.messageId);
      const { File } = await import("expo-file-system");
      const temporary = new File(file.parentDirectory, `${file.name}.${Date.now()}.tmp`);
      temporary.create({ intermediates: true, overwrite: true });
      temporary.write(JSON.stringify(encodeQueuedThreadMessage(message)));
      await temporary.move(file, { overwrite: true });
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "write",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        fileName,
        cause,
      });
    }
  },
  remove: async (message) => {
    const fileName = messageFileName(message.messageId);
    try {
      const file = await getMessageFile(message.messageId);
      if (file.exists) {
        file.delete();
      }
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        fileName,
        cause,
      });
    }
  },
};
