import type {
  ProviderEvent,
  ProviderInterruptTurnInput,
  ProviderKind,
  ProviderRespondToRequestInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";

export interface ProviderThreadTurnSnapshot {
  id: string;
  items: unknown[];
}

export interface ProviderThreadSnapshot {
  threadId: string;
  turns: ProviderThreadTurnSnapshot[];
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  hasSession(sessionId: string): boolean;
  startSession(input: ProviderSessionStartInput): Promise<ProviderSession>;
  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult>;
  interruptTurn(input: ProviderInterruptTurnInput): Promise<void>;
  respondToRequest(input: ProviderRespondToRequestInput): Promise<void>;
  stopSession(input: ProviderStopSessionInput): void;
  listSessions(): ProviderSession[];
  readThread(sessionId: string): Promise<ProviderThreadSnapshot>;
  rollbackThread(sessionId: string, numTurns: number): Promise<ProviderThreadSnapshot>;
  stopAll(): void;
  dispose(): void;
}
