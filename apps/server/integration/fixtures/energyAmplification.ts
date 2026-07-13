import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";

import type {
  FixtureProviderRuntimeEvent,
  TestTurnResponse,
} from "../TestProviderAdapter.integration.ts";

export const ENERGY_AMPLIFICATION_SHAPE = {
  providerChunkCount: 9_200,
  commandOutputBytes: 22 * 1024 * 1024,
} as const;

export const ENERGY_AMPLIFICATION_EXPECTED = {
  commandOutputSha256: "fba6dd53ee07a034f5807278fb9938893f652b6bb96782959cbeeabacd1e6fb0",
  finalTranscript: "Subagent retained its exact final answer after the command-output flood.\n",
  finalTranscriptSha256: "5d6b773121f298070d5e1af3ef4986a722c3c21f71fa065dae9b6e279d1f5566",
} as const;

export type EnergyAmplificationTerminalState = "completed" | "interrupted";

export interface EnergyAmplificationFixtureOptions {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly providerThreadId?: string;
  readonly providerChunkCount?: number;
  readonly commandOutputBytes?: number;
  readonly terminalState?: EnergyAmplificationTerminalState;
}

export interface EnergyAmplificationFixture {
  readonly response: TestTurnResponse;
  readonly providerChunks: ReadonlyArray<string>;
  readonly providerChunkCount: number;
  readonly commandOutputBytes: number;
  readonly finalTranscript: string;
  readonly terminalState: EnergyAmplificationTerminalState;
}

const FIXTURE_PROVIDER = ProviderDriverKind.make("codex");
const FIXTURE_TIMESTAMP = "2026-07-10T15:10:34.000Z";

function fixtureTimestamp(_sequence: number): string {
  return FIXTURE_TIMESTAMP;
}

function chunkLengthAt(index: number, chunkCount: number, byteCount: number): number {
  const minimumLength = Math.floor(byteCount / chunkCount);
  return minimumLength + (index < byteCount % chunkCount ? 1 : 0);
}

function makeCommandOutputChunk(index: number, byteLength: number): string {
  const prefix = `[chunk ${index.toString().padStart(4, "0")}] `;
  if (byteLength < prefix.length + 1) {
    throw new Error(
      `Command-output chunk ${index} needs at least ${prefix.length + 1} bytes, got ${byteLength}.`,
    );
  }
  const fillCharacter = String.fromCharCode(97 + (index % 26));
  return `${prefix}${fillCharacter.repeat(byteLength - prefix.length - 1)}\n`;
}

export function makeEnergyAmplificationProviderChunks(
  providerChunkCount: number = ENERGY_AMPLIFICATION_SHAPE.providerChunkCount,
  commandOutputBytes: number = ENERGY_AMPLIFICATION_SHAPE.commandOutputBytes,
): ReadonlyArray<string> {
  if (!Number.isSafeInteger(providerChunkCount) || providerChunkCount <= 0) {
    throw new Error("providerChunkCount must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(commandOutputBytes) || commandOutputBytes <= 0) {
    throw new Error("commandOutputBytes must be a positive safe integer.");
  }

  return Array.from({ length: providerChunkCount }, (_, index) =>
    makeCommandOutputChunk(index, chunkLengthAt(index, providerChunkCount, commandOutputBytes)),
  );
}

function runtimeBase(eventId: string, sequence: number) {
  return {
    eventId: EventId.make(eventId),
    provider: FIXTURE_PROVIDER,
    createdAt: fixtureTimestamp(sequence),
  };
}

export function makeEnergyAmplificationFixture(
  options: EnergyAmplificationFixtureOptions,
): EnergyAmplificationFixture {
  const turnId = options.turnId ?? TurnId.make("fixture-energy-turn");
  const providerThreadId = options.providerThreadId ?? "provider-energy-subagent";
  const providerChunkCount =
    options.providerChunkCount ?? ENERGY_AMPLIFICATION_SHAPE.providerChunkCount;
  const commandOutputBytes =
    options.commandOutputBytes ?? ENERGY_AMPLIFICATION_SHAPE.commandOutputBytes;
  const terminalState = options.terminalState ?? "completed";
  const providerChunks = makeEnergyAmplificationProviderChunks(
    providerChunkCount,
    commandOutputBytes,
  );
  const agentContext = {
    providerThreadId,
    parentTurnId: turnId,
  } as const;
  const providerChunkEvents: ReadonlyArray<FixtureProviderRuntimeEvent> = providerChunks.map(
    (delta, index) => ({
      type: "content.delta",
      ...runtimeBase(`energy-output-${index}`, index + 2),
      threadId: options.threadId,
      turnId,
      itemId: "energy-command",
      agentContext,
      payload: {
        streamKind: "command_output",
        delta,
      },
    }),
  );
  const finalTranscript = ENERGY_AMPLIFICATION_EXPECTED.finalTranscript;
  const terminalEvents: ReadonlyArray<FixtureProviderRuntimeEvent> =
    terminalState === "interrupted"
      ? [
          {
            type: "content.delta",
            ...runtimeBase("energy-subagent-final-delta", providerChunkCount + 2),
            threadId: options.threadId,
            turnId,
            itemId: "energy-subagent-message",
            agentContext,
            payload: {
              streamKind: "assistant_text",
              delta: finalTranscript,
            },
          },
          {
            type: "turn.aborted",
            ...runtimeBase("energy-turn-aborted", providerChunkCount + 3),
            threadId: options.threadId,
            turnId,
            payload: { reason: "Interrupted by deterministic fixture." },
          },
        ]
      : [
          {
            type: "item.completed",
            ...runtimeBase("energy-subagent-completed", providerChunkCount + 2),
            threadId: options.threadId,
            turnId,
            itemId: "energy-subagent-message",
            agentContext,
            payload: {
              itemType: "assistant_message",
              status: "completed",
              detail: finalTranscript,
            },
          },
          {
            type: "turn.completed",
            ...runtimeBase("energy-turn-completed", providerChunkCount + 3),
            threadId: options.threadId,
            turnId,
            payload: { state: "completed" },
          },
        ];
  const events: ReadonlyArray<FixtureProviderRuntimeEvent> = [
    {
      type: "turn.started",
      ...runtimeBase("energy-turn-started", 0),
      threadId: options.threadId,
      turnId,
    },
    {
      type: "item.started",
      ...runtimeBase("energy-subagent-started", 1),
      threadId: options.threadId,
      turnId,
      itemId: "energy-subagent-message",
      agentContext,
      payload: {
        itemType: "assistant_message",
        title: "Subagent response",
      },
    },
    ...providerChunkEvents,
    ...terminalEvents,
  ];

  return {
    response: { events },
    providerChunks,
    providerChunkCount,
    commandOutputBytes,
    finalTranscript,
    terminalState,
  };
}
