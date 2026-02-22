import {
  providerInterruptTurnInputSchema,
  providerRespondToRequestInputSchema,
  providerSendTurnInputSchema,
  providerSessionStartInputSchema,
  providerStopSessionInputSchema,
} from "@t3tools/contracts";
import type {
  ProviderEvent,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";

import { CodexAppServerManager } from "../../codexAppServerManager";
import type { ProviderAdapter, ProviderThreadSnapshot } from "./providerAdapter";

export class CodexProviderAdapter implements ProviderAdapter {
  readonly kind = "codex" as const;
  private readonly manager = new CodexAppServerManager();

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.manager.on("event", listener);
    return () => {
      this.manager.off("event", listener);
    };
  }

  hasSession(sessionId: string): boolean {
    return this.manager.hasSession(sessionId);
  }

  startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const parsed = providerSessionStartInputSchema.parse(input);
    if (parsed.provider !== this.kind) {
      throw new Error(`Provider '${parsed.provider}' is not implemented by CodexProviderAdapter.`);
    }
    return this.manager.startSession(parsed);
  }

  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.manager.sendTurn(providerSendTurnInputSchema.parse(input));
  }

  interruptTurn(input: ProviderInterruptTurnInput): Promise<void> {
    const parsed = providerInterruptTurnInputSchema.parse(input);
    return this.manager.interruptTurn(parsed.sessionId, parsed.turnId);
  }

  respondToRequest(input: ProviderRespondToRequestInput): Promise<void> {
    const parsed = providerRespondToRequestInputSchema.parse(input);
    return this.manager.respondToRequest(parsed.sessionId, parsed.requestId, parsed.decision);
  }

  stopSession(input: ProviderStopSessionInput): void {
    const parsed = providerStopSessionInputSchema.parse(input);
    this.manager.stopSession(parsed.sessionId);
  }

  listSessions(): ProviderSession[] {
    return this.manager.listSessions();
  }

  async readThread(sessionId: string): Promise<ProviderThreadSnapshot> {
    const snapshot = await this.manager.readThread(sessionId);
    return {
      threadId: snapshot.threadId,
      turns: snapshot.turns.map((turn) => ({
        id: turn.id,
        items: turn.items,
      })),
    };
  }

  async rollbackThread(sessionId: string, numTurns: number): Promise<ProviderThreadSnapshot> {
    const snapshot = await this.manager.rollbackThread(sessionId, numTurns);
    return {
      threadId: snapshot.threadId,
      turns: snapshot.turns.map((turn) => ({
        id: turn.id,
        items: turn.items,
      })),
    };
  }

  stopAll(): void {
    this.manager.stopAll();
  }

  dispose(): void {
    this.manager.stopAll();
  }
}
