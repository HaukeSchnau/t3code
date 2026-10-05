/**
 * Durable composer sends for web and desktop. A send made while the
 * environment is unreachable, or whose reply never arrived, waits here across
 * reloads and is delivered in order once the environment is back. The command
 * id stays fixed, so the server's command receipts turn a repeated delivery
 * into a replay. See patches/durable-client-command-outbox.md.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  classifyCommandDeliveryFailure,
  CommandOutboxState,
  createCommandOutboxController,
  type CommandOutboxController,
  type CommandOutboxEntry,
  type CommandOutboxStore,
} from "@t3tools/client-runtime/state/command-outbox";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChatFileAttachment,
  ChatImageAttachment,
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
  markPromotedDraftThreadByRef,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "./composerDraftStore";
import { environmentCatalog } from "./connection/catalog";
import { deliverDurableComposerCommand } from "./durableCommandOutboxDelivery";
import { stripInlineContextReferences } from "./lib/composerContextReferences";
import { randomUUID } from "./lib/utils";
import { readAttachmentUpload, releaseDraftAttachment } from "./lib/attachmentUploadQueue";
import { appAtomRegistry } from "./rpc/atomRegistry";

const DATABASE_NAME = "t3code:thread-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "entries";
const BROADCAST_CHANNEL = "t3code:thread-outbox";
const DRAIN_LOCK = "t3code:thread-outbox:drain";

const DurableComposerAttachment = Schema.Struct({
  attachment: Schema.Union([ChatImageAttachment, ChatFileAttachment]),
  // The bytes stay on this device until an upload succeeds, and afterwards so
  // a rejected message can return to the composer.
  blob: Schema.NullOr(Schema.instanceOf(Blob)),
  uploadedAttachmentId: Schema.optionalKey(Schema.String),
});
export type DurableComposerAttachment = typeof DurableComposerAttachment.Type;

const DurableThreadBootstrap = Schema.Struct({
  createThread: Schema.optionalKey(
    Schema.Struct({
      projectId: ProjectId,
      title: Schema.String,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
      branch: Schema.NullOr(Schema.String),
      worktreePath: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  ),
  prepareWorktree: Schema.optionalKey(
    Schema.Struct({
      requireWorktree: Schema.optionalKey(Schema.Boolean),
      projectCwd: Schema.String,
      baseBranch: Schema.String,
      branch: Schema.optionalKey(Schema.String),
      startFromOrigin: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  runSetupScript: Schema.optionalKey(Schema.Boolean),
});

/** Everything a composer send needs, frozen when the user pressed send. */
export const DurableComposerCommand = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  createdAt: Schema.String,
  text: Schema.String,
  context: Schema.optionalKey(OrchestrationMessageContext),
  attachments: Schema.Array(DurableComposerAttachment),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  // The server resolves queue or steer against the thread at delivery time.
  dispatchMode: Schema.Literals(["auto", "queue", "steer", "restart"]),
  titleSeed: Schema.String,
  bootstrap: Schema.optionalKey(DurableThreadBootstrap),
});
export type DurableComposerCommand = typeof DurableComposerCommand.Type;
export type DurableComposerEntry = CommandOutboxEntry<DurableComposerCommand>;

const NewEntry = Schema.Struct({
  enqueuedAt: Schema.Number,
  command: DurableComposerCommand,
  state: CommandOutboxState,
});
// IndexedDB assigns `id` on add.
const StoredEntry = NewEntry.mapFields((fields) => ({ id: Schema.Number, ...fields }));
const decodeStoredEntry = Schema.decodeUnknownOption(StoredEntry);
const encodeStoredEntry = Schema.encodeSync(StoredEntry);
const encodeNewEntry = Schema.encodeSync(NewEntry);

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser cannot save messages on the device."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    });
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open the message outbox.")),
    );
    request.addEventListener("success", () => resolve(request.result));
  });
}

let database: Promise<IDBDatabase> | null = null;

function connect(): Promise<IDBDatabase> {
  database ??= openDatabase().then(
    (opened) => {
      // A later version (another tab after an update) asks us to step aside.
      opened.addEventListener("versionchange", () => {
        opened.close();
        database = null;
      });
      opened.addEventListener("close", () => {
        database = null;
      });
      return opened;
    },
    (error: unknown) => {
      database = null;
      throw error;
    },
  );
  return database;
}

const changes =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(BROADCAST_CHANNEL);

/**
 * Runs `body` in one transaction and resolves with its result once the
 * transaction committed. `body` must issue its requests synchronously from
 * request callbacks so the read-modify-write stays atomic across tabs.
 */
async function transact<A>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, settle: (value: A) => void, fail: (error: Error) => void) => void,
): Promise<A> {
  const opened = await connect();
  const result = await new Promise<A>((resolve, reject) => {
    const transaction = opened.transaction(STORE_NAME, mode);
    let value: { readonly current: A } | null = null;
    let failure: Error | null = null;
    transaction.addEventListener("complete", () => {
      if (value === null) reject(new Error("The message outbox transaction ended early."));
      else resolve(value.current);
    });
    transaction.addEventListener("abort", () =>
      reject(failure ?? transaction.error ?? new Error("The message outbox write was aborted.")),
    );
    try {
      body(
        transaction.objectStore(STORE_NAME),
        (next) => {
          value = { current: next };
        },
        (error) => {
          failure = error;
          transaction.abort();
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      transaction.abort();
    }
  });
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel takes no origin.
  if (mode === "readwrite") changes?.postMessage("changed");
  return result;
}

function decodeRows(rows: ReadonlyArray<unknown>): ReadonlyArray<DurableComposerEntry> {
  return rows.flatMap((row) =>
    Option.match(decodeStoredEntry(row), {
      onNone: () => {
        // Leave the record alone: a newer build may still read it.
        console.warn("Skipping an unreadable message in the outbox", row);
        return [];
      },
      onSome: (entry) => [entry],
    }),
  );
}

export const indexedDbOutboxStore: CommandOutboxStore<DurableComposerCommand> = {
  list: () =>
    transact<ReadonlyArray<DurableComposerEntry>>("readonly", (store, settle) => {
      const request = store.getAll();
      request.addEventListener("success", () => settle(decodeRows(request.result)));
    }),
  add: (entry) =>
    transact<DurableComposerEntry>("readwrite", (store, settle, fail) => {
      const existing = store.getAll();
      existing.addEventListener("success", () => {
        if (
          decodeRows(existing.result).some(
            (stored) => stored.command.commandId === entry.command.commandId,
          )
        ) {
          fail(new Error(`Command ${entry.command.commandId} is already in the outbox.`));
          return;
        }
        const added = store.add(encodeNewEntry(entry));
        added.addEventListener("success", () => settle({ ...entry, id: Number(added.result) }));
      });
    }),
  update: (id, change) =>
    transact<DurableComposerEntry | null | undefined>("readwrite", (store, settle) => {
      const request = store.get(id);
      request.addEventListener("success", () => {
        const current = Option.getOrUndefined(decodeStoredEntry(request.result));
        const next = current === undefined ? undefined : change(current);
        if (next === null) store.delete(id);
        else if (next !== undefined) store.put(encodeStoredEntry(next));
        settle(next);
      });
    }),
};

function withDrainLock(drain: () => Promise<void>): Promise<void> {
  // One tab drains at a time; without Web Locks, receipts still dedupe.
  if (typeof navigator === "undefined" || navigator.locks === undefined) return drain();
  return navigator.locks.request(DRAIN_LOCK, drain);
}

function isEnvironmentConnected(environmentId: EnvironmentId): boolean {
  return Option.exists(
    AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    (state) => state.phase === "connected",
  );
}

const rejectionListeners = new Set<(entry: DurableComposerEntry) => void>();
let liveController: CommandOutboxController<DurableComposerCommand> | null = null;

function startController(): CommandOutboxController<DurableComposerCommand> {
  const controller = createCommandOutboxController<DurableComposerCommand>({
    store: indexedDbOutboxStore,
    deliver: deliverDurableComposerCommand,
    canDeliver: (command) => isEnvironmentConnected(command.environmentId),
    withDrainLock,
    onRejected: (entry) => {
      for (const listener of rejectionListeners) listener(entry);
    },
    onError: (error) => console.error("The message outbox could not deliver", error),
    now: () => Date.now(),
    setTimer: (callback, delayMs) => {
      const handle = window.setTimeout(callback, delayMs);
      return () => window.clearTimeout(handle);
    },
  });

  // Wake on reconnect for every environment that has waiting messages.
  const watched = new Map<EnvironmentId, () => void>();
  const watchEnvironments = () => {
    const needed = new Set(controller.entries().map((entry) => entry.command.environmentId));
    for (const [environmentId, unwatch] of watched) {
      if (needed.has(environmentId)) continue;
      unwatch();
      watched.delete(environmentId);
    }
    for (const environmentId of needed) {
      if (watched.has(environmentId)) continue;
      let connected = isEnvironmentConnected(environmentId);
      watched.set(
        environmentId,
        appAtomRegistry.subscribe(environmentCatalog.stateAtom(environmentId), () => {
          const next = isEnvironmentConnected(environmentId);
          if (next && !connected) void controller.wake();
          connected = next;
        }),
      );
    }
  };
  controller.subscribe(watchEnvironments);

  changes?.addEventListener("message", () => void controller.refresh());
  window.addEventListener("online", () => void controller.wake());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void controller.wake();
  });
  return controller;
}

export function durableCommandOutbox(): CommandOutboxController<DurableComposerCommand> {
  liveController ??= startController();
  return liveController;
}

const EMPTY_ENTRIES: ReadonlyArray<DurableComposerEntry> = [];
const noopSubscribe = () => () => undefined;

function useOutboxEntries(): ReadonlyArray<DurableComposerEntry> {
  const controller = typeof window === "undefined" ? null : durableCommandOutbox();
  return useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.entries ?? (() => EMPTY_ENTRIES),
    () => EMPTY_ENTRIES,
  );
}

/** Starts delivery for the app session and reports rejections wherever the user is. */
export function useDurableCommandOutbox(onRejected: (entry: DurableComposerEntry) => void): void {
  useEffect(() => {
    durableCommandOutbox();
    rejectionListeners.add(onRejected);
    return () => {
      rejectionListeners.delete(onRejected);
    };
  }, [onRejected]);
}

/**
 * The thread's waiting messages, oldest first. Messages the server already
 * shows are dropped: their delivery succeeded even if no reply said so.
 */
export function useThreadDurableOutbox(
  threadRef: ScopedThreadRef | null,
  serverMessageIds: ReadonlySet<string>,
): ReadonlyArray<DurableComposerEntry> {
  const entries = useOutboxEntries();
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const threadEntries = useMemo(
    () =>
      threadKey === null
        ? EMPTY_ENTRIES
        : entries.filter((entry) => scopedThreadKey(entry.command) === threadKey),
    [entries, threadKey],
  );
  useEffect(() => {
    if (!threadEntries.some((entry) => serverMessageIds.has(entry.command.messageId))) return;
    void durableCommandOutbox().settle(
      (command) =>
        scopedThreadKey(command) === threadKey && serverMessageIds.has(command.messageId),
    );
  }, [serverMessageIds, threadEntries, threadKey]);
  return threadEntries;
}

function durableAttachment(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
  environmentId: EnvironmentId,
): DurableComposerAttachment {
  const upload = readAttachmentUpload(attachment.id);
  const uploadedAttachmentId =
    upload?.status === "ready" && upload.environmentId === environmentId
      ? upload.attachmentId
      : attachment.type === "file" && attachment.uploadEnvironmentId === environmentId
        ? attachment.uploadedAttachmentId
        : undefined;
  if (attachment.file === null && uploadedAttachmentId === undefined) {
    throw new Error(`Attach '${attachment.name}' again before sending.`);
  }
  const { id, name, mimeType, sizeBytes } = attachment;
  return {
    attachment:
      attachment.type === "image"
        ? {
            type: "image",
            id,
            name,
            mimeType,
            sizeBytes,
            ...(attachment.source ? { source: attachment.source } : {}),
          }
        : {
            type: "file",
            id,
            name,
            mimeType,
            sizeBytes,
            ...(attachment.source ? { source: attachment.source } : {}),
          },
    blob: attachment.file,
    ...(uploadedAttachmentId === undefined ? {} : { uploadedAttachmentId }),
  };
}

export interface DurableComposerSend {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly createdAt: string;
  readonly text: string;
  readonly context: OrchestrationMessageContext | undefined;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly dispatchMode: ComposerDispatchMode;
  /** Set for a draft's first message, which creates the thread. */
  readonly createThread: {
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly createdAt: string;
  } | null;
  readonly prepareWorktree: {
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly startFromOrigin: boolean;
  } | null;
}

function threadBootstrap(
  send: DurableComposerSend,
  title: string,
): StartThreadTurnInput["bootstrap"] {
  if (send.createThread === null && send.prepareWorktree === null) return undefined;
  return {
    ...(send.createThread === null
      ? {}
      : {
          createThread: {
            ...send.createThread,
            title,
            modelSelection: send.modelSelection,
            runtimeMode: send.runtimeMode,
            interactionMode: send.interactionMode,
          },
        }),
    ...(send.prepareWorktree === null
      ? {}
      : {
          prepareWorktree: {
            projectCwd: send.prepareWorktree.projectCwd,
            baseBranch: send.prepareWorktree.baseBranch,
            ...(send.prepareWorktree.startFromOrigin ? { startFromOrigin: true } : {}),
          },
          runSetupScript: true,
        }),
  };
}

/**
 * Saves a composer send on this device. A direct send that already went out
 * passes its command id so delivery reuses it; `acknowledgementLost` marks
 * that it may have arrived.
 */
export async function enqueueComposerSend(
  send: DurableComposerSend,
  directSend?: { readonly commandId: CommandId; readonly acknowledgementLost: boolean },
): Promise<void> {
  const controller = durableCommandOutbox();
  const threadKey = scopedThreadKey(send);
  // A follow-up written before the thread's launch went out joins that thread.
  const launchPending = controller
    .entries()
    .some(
      (entry) =>
        scopedThreadKey(entry.command) === threadKey &&
        entry.command.bootstrap?.createThread !== undefined,
    );
  const attachments = send.attachments.map((attachment) =>
    durableAttachment(attachment, send.environmentId),
  );
  const titleSeed = deriveThreadTitleSeed({
    text: stripInlineContextReferences(send.text),
    attachments: send.attachments,
  });
  const bootstrap = launchPending ? undefined : threadBootstrap(send, titleSeed);
  await controller.enqueue(
    {
      environmentId: send.environmentId,
      threadId: send.threadId,
      commandId: directSend?.commandId ?? CommandId.make(randomUUID()),
      messageId: send.messageId,
      createdAt: send.createdAt,
      text: send.text,
      ...(send.context ? { context: send.context } : {}),
      attachments,
      modelSelection: send.modelSelection,
      runtimeMode: send.runtimeMode,
      interactionMode: send.interactionMode,
      dispatchMode: send.dispatchMode,
      titleSeed,
      ...(bootstrap ? { bootstrap } : {}),
    },
    { acknowledgementLost: directSend?.acknowledgementLost === true },
  );
  // The outbox owns these files now. Uploads it adopted stay on the server;
  // the composer's other jobs would otherwise retry on reconnect.
  send.attachments.forEach((attachment, index) => {
    if (attachments[index]?.uploadedAttachmentId === undefined) releaseDraftAttachment(attachment);
  });
  if (bootstrap?.createThread) {
    // A sent draft must survive reloads and must not be reused for the next new thread.
    markPromotedDraftThreadByRef({ environmentId: send.environmentId, threadId: send.threadId });
  }
}

/**
 * A direct send that failed on the way to the environment continues in the
 * outbox under its command id instead of returning to the composer, where a
 * second send could duplicate it. Resolves false for a decided rejection.
 */
export async function handOffUnconfirmedSend(
  result: AtomCommandResult<unknown, unknown>,
  send: DurableComposerSend,
  commandId: CommandId,
): Promise<boolean> {
  if (result._tag === "Success") return false;
  const { classification } = isAtomCommandInterrupted(result)
    ? { classification: "ambiguous" as const }
    : classifyCommandDeliveryFailure(squashAtomCommandFailure(result));
  if (classification === "permanent") return false;
  try {
    await enqueueComposerSend(send, {
      commandId,
      acknowledgementLost: classification === "ambiguous",
    });
    return true;
  } catch (error) {
    console.error("Could not keep the unconfirmed message on this device", error);
    return false;
  }
}

export interface RestoredComposerContent {
  readonly text: string;
  readonly images: ComposerImageAttachment[];
  readonly files: ComposerFileAttachment[];
  /** The message would have created its thread, so the draft is open again. */
  readonly createsThread: boolean;
}

/** The message as composer content, for editing after it was taken out of the outbox. */
export function restoredComposerContent(entry: DurableComposerEntry): RestoredComposerContent {
  const { command } = entry;
  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  for (const { attachment, blob, uploadedAttachmentId } of command.attachments) {
    const file =
      blob === null ? null : new File([blob], attachment.name, { type: attachment.mimeType });
    if (attachment.type === "image" && file !== null) {
      images.push({ ...attachment, previewUrl: URL.createObjectURL(file), file });
    } else if (attachment.type === "file") {
      files.push({
        ...attachment,
        file,
        ...(uploadedAttachmentId === undefined
          ? {}
          : { uploadedAttachmentId, uploadEnvironmentId: command.environmentId }),
      });
    }
  }
  return {
    // Context chips cannot be rebuilt from wire records; spell them out instead.
    text: command.context
      ? serializeLegacyContextMessage({ text: command.text, records: command.context.records })
      : command.text,
    images,
    files,
    createsThread: command.bootstrap?.createThread !== undefined,
  };
}
