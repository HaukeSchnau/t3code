import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type {
  ProviderCheckpoint,
  ProviderEvent,
  ProviderGetCheckpointDiffInput,
  ProviderGetCheckpointDiffResult,
  ProviderInterruptTurnInput,
  ProviderKind,
  ProviderListCheckpointsInput,
  ProviderListCheckpointsResult,
  ProviderRevertToCheckpointInput,
  ProviderRevertToCheckpointResult,
  ProviderRespondToRequestInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  providerGetCheckpointDiffInputSchema,
  providerInterruptTurnInputSchema,
  providerListCheckpointsInputSchema,
  providerRevertToCheckpointInputSchema,
  providerRespondToRequestInputSchema,
  providerSendTurnInputSchema,
  providerSessionStartInputSchema,
  providerStopSessionInputSchema,
} from "@t3tools/contracts";

import { FilesystemCheckpointStore } from "../../filesystemCheckpointStore";
import type { ProviderAdapter, ProviderThreadTurnSnapshot } from "./providerAdapter";

export interface ProviderOrchestratorEvents {
  event: [event: ProviderEvent];
}

export class ProviderOrchestrator extends EventEmitter<ProviderOrchestratorEvents> {
  private readonly adapters: Map<ProviderKind, ProviderAdapter>;
  private readonly filesystemCheckpointStore = new FilesystemCheckpointStore();
  private readonly sessionToProvider = new Map<string, ProviderKind>();
  private readonly sessionCheckpointCwds = new Map<string, string>();
  private readonly filesystemLocks = new Map<string, Promise<void>>();
  private readonly unsubscribers: Array<() => void>;

  constructor(adapters: ProviderAdapter[]) {
    super();
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter] as const));
    this.unsubscribers = adapters.map((adapter) =>
      adapter.onEvent((event) => {
        this.sessionToProvider.set(event.sessionId, event.provider);
        this.emit("event", event);
        this.maybeCaptureFilesystemCheckpoint(event);
      }),
    );
  }

  async startSession(raw: ProviderSessionStartInput): Promise<ProviderSession> {
    const input = providerSessionStartInputSchema.parse(raw);
    const provider = input.provider ?? "codex";
    const adapter = this.requireAdapter(provider);
    const session = await adapter.startSession(input);
    this.sessionToProvider.set(session.sessionId, session.provider);
    await this.initializeFilesystemCheckpointing(adapter, session, input.cwd).catch((error) => {
      const message =
        error instanceof Error ? error.message : "Failed to initialize filesystem checkpoints.";
      this.emitFilesystemCheckpointError(session.sessionId, message, session.threadId);
    });
    return session;
  }

  async sendTurn(raw: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const input = providerSendTurnInputSchema.parse(raw);
    return this.resolveAdapterForSession(input.sessionId).sendTurn(input);
  }

  async interruptTurn(raw: ProviderInterruptTurnInput): Promise<void> {
    const input = providerInterruptTurnInputSchema.parse(raw);
    return this.resolveAdapterForSession(input.sessionId).interruptTurn(input);
  }

  async respondToRequest(raw: ProviderRespondToRequestInput): Promise<void> {
    const input = providerRespondToRequestInputSchema.parse(raw);
    return this.resolveAdapterForSession(input.sessionId).respondToRequest(input);
  }

  stopSession(raw: ProviderStopSessionInput): void {
    const input = providerStopSessionInputSchema.parse(raw);
    this.resolveAdapterForSession(input.sessionId).stopSession(input);
    this.sessionToProvider.delete(input.sessionId);
    this.sessionCheckpointCwds.delete(input.sessionId);
    this.filesystemLocks.delete(input.sessionId);
  }

  listSessions(): ProviderSession[] {
    const sessions = [...this.adapters.values()].flatMap((adapter) => adapter.listSessions());
    for (const session of sessions) {
      this.sessionToProvider.set(session.sessionId, session.provider);
    }
    return sessions;
  }

  async listCheckpoints(raw: ProviderListCheckpointsInput): Promise<ProviderListCheckpointsResult> {
    const input = providerListCheckpointsInputSchema.parse(raw);
    const adapter = this.resolveAdapterForSession(input.sessionId);
    const snapshot = await adapter.readThread(input.sessionId);
    return {
      threadId: snapshot.threadId,
      checkpoints: buildCheckpoints(snapshot.turns),
    };
  }

  async getCheckpointDiff(
    raw: ProviderGetCheckpointDiffInput,
  ): Promise<ProviderGetCheckpointDiffResult> {
    const input = providerGetCheckpointDiffInputSchema.parse(raw);
    const adapter = this.resolveAdapterForSession(input.sessionId);
    const checkpointCwd = await this.getOrInitializeFilesystemCheckpointCwd(input.sessionId, adapter);
    if (!checkpointCwd) {
      throw new Error("Filesystem checkpoints are unavailable for this session.");
    }

    return this.withFilesystemLock(input.sessionId, async () => {
      const snapshot = await adapter.readThread(input.sessionId);
      if (input.toTurnCount > snapshot.turns.length) {
        throw new Error(
          `Checkpoint turn count ${input.toTurnCount} exceeds current turn count ${snapshot.turns.length}.`,
        );
      }

      const diff = await this.filesystemCheckpointStore.diffCheckpoints({
        cwd: checkpointCwd,
        threadId: snapshot.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
      });
      return {
        threadId: snapshot.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
    });
  }

  async revertToCheckpoint(
    raw: ProviderRevertToCheckpointInput,
  ): Promise<ProviderRevertToCheckpointResult> {
    const input = providerRevertToCheckpointInputSchema.parse(raw);
    const adapter = this.resolveAdapterForSession(input.sessionId);
    const checkpointCwd = await this.getOrInitializeFilesystemCheckpointCwd(input.sessionId, adapter);
    if (!checkpointCwd) {
      throw new Error("Filesystem checkpoints are unavailable for this session.");
    }

    return this.withFilesystemLock(input.sessionId, async () => {
      const beforeSnapshot = await adapter.readThread(input.sessionId);
      const currentTurnCount = beforeSnapshot.turns.length;
      if (input.turnCount > currentTurnCount) {
        throw new Error(
          `Checkpoint turn count ${input.turnCount} exceeds current turn count ${currentTurnCount}.`,
        );
      }

      if (input.turnCount > 0) {
        const hasCheckpoint = await this.filesystemCheckpointStore.hasCheckpoint({
          cwd: checkpointCwd,
          threadId: beforeSnapshot.threadId,
          turnCount: input.turnCount,
        });
        if (!hasCheckpoint) {
          throw new Error(
            `Filesystem checkpoint is unavailable for turn ${input.turnCount} in thread ${beforeSnapshot.threadId}.`,
          );
        }
      }

      const restored = await this.filesystemCheckpointStore.restoreCheckpoint({
        cwd: checkpointCwd,
        threadId: beforeSnapshot.threadId,
        turnCount: input.turnCount,
      });
      if (!restored) {
        throw new Error(
          `Filesystem checkpoint is unavailable for turn ${input.turnCount} in thread ${beforeSnapshot.threadId}.`,
        );
      }

      const rollbackTurns = currentTurnCount - input.turnCount;
      const afterSnapshot =
        rollbackTurns > 0
          ? await adapter.rollbackThread(input.sessionId, rollbackTurns)
          : beforeSnapshot;

      await this.filesystemCheckpointStore.pruneAfterTurn({
        cwd: checkpointCwd,
        threadId: afterSnapshot.threadId,
        maxTurnCount: afterSnapshot.turns.length,
      });

      const checkpoints = buildCheckpoints(afterSnapshot.turns);
      const currentCheckpoint =
        checkpoints.find((checkpoint) => checkpoint.isCurrent) ??
        checkpoints[checkpoints.length - 1] ??
        checkpoints[0];
      const rolledBackTurns = Math.max(0, currentTurnCount - afterSnapshot.turns.length);

      return {
        threadId: afterSnapshot.threadId,
        turnCount: currentCheckpoint?.turnCount ?? 0,
        messageCount: currentCheckpoint?.messageCount ?? 0,
        rolledBackTurns,
        checkpoints,
      };
    });
  }

  stopAll(): void {
    for (const adapter of this.adapters.values()) {
      adapter.stopAll();
    }
    this.sessionToProvider.clear();
    this.sessionCheckpointCwds.clear();
    this.filesystemLocks.clear();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    for (const adapter of this.adapters.values()) {
      adapter.dispose();
    }
    this.unsubscribers.length = 0;
    this.sessionToProvider.clear();
    this.sessionCheckpointCwds.clear();
    this.filesystemLocks.clear();
  }

  private async initializeFilesystemCheckpointing(
    adapter: ProviderAdapter,
    session: ProviderSession,
    preferredCwd?: string,
  ): Promise<void> {
    const cwd = preferredCwd ?? session.cwd ?? process.cwd();
    await this.withFilesystemLock(session.sessionId, async () => {
      const supportsGit = await this.filesystemCheckpointStore.isGitRepository(cwd);
      if (!supportsGit) {
        this.sessionCheckpointCwds.delete(session.sessionId);
        return;
      }

      const snapshot = await adapter.readThread(session.sessionId);
      await this.filesystemCheckpointStore.ensureRootCheckpoint({
        cwd,
        threadId: snapshot.threadId,
      });
      await this.filesystemCheckpointStore.captureCheckpoint({
        cwd,
        threadId: snapshot.threadId,
        turnCount: snapshot.turns.length,
      });
      this.sessionCheckpointCwds.set(session.sessionId, cwd);
    });
  }

  private async getOrInitializeFilesystemCheckpointCwd(
    sessionId: string,
    adapter: ProviderAdapter,
  ): Promise<string | null> {
    const existingCwd = this.sessionCheckpointCwds.get(sessionId);
    if (existingCwd) return existingCwd;

    const session = adapter.listSessions().find((entry) => entry.sessionId === sessionId);
    const candidateCwds = session?.cwd ? [session.cwd] : [process.cwd()];

    await this.withFilesystemLock(sessionId, async () => {
      const currentCwd = this.sessionCheckpointCwds.get(sessionId);
      if (currentCwd) return;

      const cwdSupport = await Promise.all(
        candidateCwds.map(async (cwd) => ({
          cwd,
          supportsGit: await this.filesystemCheckpointStore.isGitRepository(cwd),
        })),
      );
      const supportedCwd = cwdSupport.find((entry) => entry.supportsGit)?.cwd;
      if (!supportedCwd) {
        this.sessionCheckpointCwds.delete(sessionId);
        return;
      }

      const snapshot = await adapter.readThread(sessionId);
      await this.filesystemCheckpointStore.ensureRootCheckpoint({
        cwd: supportedCwd,
        threadId: snapshot.threadId,
      });
      await this.filesystemCheckpointStore.captureCheckpoint({
        cwd: supportedCwd,
        threadId: snapshot.threadId,
        turnCount: snapshot.turns.length,
      });
      this.sessionCheckpointCwds.set(sessionId, supportedCwd);
    });

    return this.sessionCheckpointCwds.get(sessionId) ?? null;
  }

  private maybeCaptureFilesystemCheckpoint(event: ProviderEvent): void {
    if (event.kind !== "notification" || event.method !== "turn/completed") {
      return;
    }
    const adapter = this.resolveAdapterForSession(event.sessionId);
    const checkpointCwd = this.sessionCheckpointCwds.get(event.sessionId);
    if (!checkpointCwd) {
      void this.getOrInitializeFilesystemCheckpointCwd(event.sessionId, adapter)
        .then(async (initializedCwd) => {
          if (!initializedCwd) return;
          const snapshot = await adapter.readThread(event.sessionId);
          this.emitCheckpointCaptured(event.sessionId, snapshot.threadId, snapshot.turns.length);
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : "Failed to initialize filesystem checkpoints.";
          this.emitFilesystemCheckpointError(event.sessionId, message, event.threadId);
        });
      return;
    }

    void this.withFilesystemLock(event.sessionId, async () => {
      const snapshot = await adapter.readThread(event.sessionId);
      await this.filesystemCheckpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        threadId: snapshot.threadId,
        turnCount: snapshot.turns.length,
      });
      this.emitCheckpointCaptured(event.sessionId, snapshot.threadId, snapshot.turns.length);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Failed to capture checkpoint.";
      this.emitFilesystemCheckpointError(event.sessionId, message, event.threadId);
    });
  }

  private emitCheckpointCaptured(sessionId: string, threadId: string, turnCount: number): void {
    this.emit("event", {
      id: randomUUID(),
      kind: "notification",
      provider: this.sessionToProvider.get(sessionId) ?? "codex",
      sessionId,
      createdAt: new Date().toISOString(),
      method: "checkpoint/captured",
      threadId,
      payload: {
        threadId,
        turnCount,
      },
    });
  }

  private emitFilesystemCheckpointError(
    sessionId: string,
    message: string,
    threadId?: string,
  ): void {
    this.emit("event", {
      id: randomUUID(),
      kind: "error",
      provider: this.sessionToProvider.get(sessionId) ?? "codex",
      sessionId,
      createdAt: new Date().toISOString(),
      method: "checkpoint/filesystemError",
      message,
      ...(threadId ? { threadId } : {}),
    });
  }

  private withFilesystemLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.filesystemLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const completion = next.then(
      () => undefined,
      () => undefined,
    );
    this.filesystemLocks.set(sessionId, completion);
    return next.finally(() => {
      const tracked = this.filesystemLocks.get(sessionId);
      if (tracked === completion) {
        this.filesystemLocks.delete(sessionId);
      }
    });
  }

  private resolveAdapterForSession(sessionId: string): ProviderAdapter {
    const mappedProvider = this.sessionToProvider.get(sessionId);
    if (mappedProvider) {
      return this.requireAdapter(mappedProvider);
    }
    for (const adapter of this.adapters.values()) {
      if (adapter.hasSession(sessionId)) {
        this.sessionToProvider.set(sessionId, adapter.kind);
        return adapter;
      }
    }
    throw new Error(`Unknown provider session: ${sessionId}`);
  }

  private requireAdapter(provider: ProviderKind): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Provider '${provider}' is not implemented yet.`);
    }
    return adapter;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimToPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117)}...`;
}

function summarizeUserMessageContent(content: unknown[]): string | undefined {
  const segments: string[] = [];
  for (const part of content) {
    const record = asObject(part);
    const type = asString(record?.type);
    if (!type) continue;
    if (type === "text") {
      const text = asString(record?.text);
      if (text && text.trim().length > 0) {
        segments.push(text.trim());
      }
      continue;
    }
    if (type === "image") {
      segments.push("[Image attachment]");
      continue;
    }
    if (type === "localImage") {
      segments.push("[Local image attachment]");
    }
  }
  if (segments.length === 0) return undefined;
  return trimToPreview(segments.join(" "));
}

function summarizeTurn(turn: ProviderThreadTurnSnapshot): { messageCountDelta: number; preview?: string } {
  let messageCountDelta = 0;
  let preview: string | undefined;
  for (const item of turn.items) {
    const record = asObject(item);
    const type = asString(record?.type);
    if (!type) continue;
    if (type === "userMessage") {
      messageCountDelta += 1;
      if (!preview) {
        preview = summarizeUserMessageContent(asArray(record?.content));
      }
      continue;
    }
    if (type === "agentMessage") {
      messageCountDelta += 1;
      if (!preview) {
        const text = asString(record?.text);
        if (text && text.trim().length > 0) {
          preview = trimToPreview(text);
        }
      }
    }
  }
  return {
    messageCountDelta,
    ...(preview ? { preview } : {}),
  };
}

function buildCheckpoints(turns: ProviderThreadTurnSnapshot[]): ProviderCheckpoint[] {
  const checkpoints: ProviderCheckpoint[] = [];
  let messageCount = 0;
  const isEmpty = turns.length === 0;
  checkpoints.push({
    id: "root",
    turnCount: 0,
    messageCount: 0,
    label: "Start of conversation",
    isCurrent: isEmpty,
  });
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) continue;
    const turnSummary = summarizeTurn(turn);
    messageCount += turnSummary.messageCountDelta;
    checkpoints.push({
      id: turn.id,
      turnCount: index + 1,
      messageCount,
      label: `Turn ${index + 1}`,
      ...(turnSummary.preview ? { preview: turnSummary.preview } : {}),
      isCurrent: index === turns.length - 1,
    });
  }
  return checkpoints;
}
