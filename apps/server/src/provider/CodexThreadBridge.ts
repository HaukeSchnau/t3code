import { MessageId, TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { buildCodexInitializeParams } from "./Layers/CodexProvider.ts";

export const CODEX_THREAD_BRIDGE_APP_SERVER_ARGS = ["app-server"] as const;
const CODEX_THREAD_BRIDGE_FORCE_KILL_AFTER = "2 seconds" as const;

type CodexThread = {
  readonly id: string;
  readonly turns: ReadonlyArray<{
    readonly id: string;
    readonly startedAt?: number | null;
    readonly status?: string;
    readonly items: ReadonlyArray<{
      readonly id?: string;
      readonly type: string;
      readonly content?: ReadonlyArray<unknown>;
      readonly text?: string;
    }>;
  }>;
};

export interface CodexProviderThreadRequest {
  readonly providerThreadId: string;
  readonly binaryPath: string;
  readonly configCwd: string;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly homePath?: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface CodexProviderThreadForkRequest extends CodexProviderThreadRequest {
  readonly cwd?: string;
  readonly lastTurnId?: string | null;
  readonly developerInstructions?: string;
}

export function codexThreadTitle(input: {
  readonly name?: string | null;
  readonly preview: string;
  readonly cwd: string;
}): string {
  const explicit = input.name?.trim();
  if (explicit) {
    return explicit;
  }
  const preview = input.preview.trim();
  if (preview) {
    return preview.slice(0, 80);
  }
  return pathBasename(input.cwd);
}

export function pathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const basename = trimmed.split(/[\\/]/).pop()?.trim();
  return basename || value;
}

export function codexThreadTimestamp(value: number | null | undefined, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Option.match(DateTime.make(value * 1000), {
    onNone: () => fallback,
    onSome: DateTime.formatIso,
  });
}

export function codexThreadMessages(input: {
  readonly thread: CodexThread;
  readonly importedAt: string;
  /**
   * Bound imports for an already-known T3 thread to the last provider turn the
   * orchestration projection still retains. `undefined` imports the whole
   * Codex thread for first-time imports; `null` imports no provider turns.
   */
  readonly importThroughTurnId?: string | null;
}) {
  const messages = [];
  const turns = codexThreadTurnsWithinImportBoundary(input.thread.turns, input.importThroughTurnId);
  for (const turn of turns) {
    const timestamp = codexThreadTimestamp(turn.startedAt, input.importedAt);
    for (const item of turn.items) {
      if (item.type === "userMessage" && item.id && item.content) {
        const text = item.content.map(codexUserInputText).join("\n").trim();
        if (!text) {
          continue;
        }
        messages.push({
          id: MessageId.make(`codex:${input.thread.id}:${turn.id}:${item.id}`),
          role: "user" as const,
          text,
          turnId: null,
          streaming: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        continue;
      }

      if (item.type === "agentMessage" && item.id && typeof item.text === "string") {
        const text = item.text.trim();
        if (!text) {
          continue;
        }
        messages.push({
          id: MessageId.make(`codex:${input.thread.id}:${turn.id}:${item.id}`),
          role: "assistant" as const,
          text,
          turnId: TurnId.make(turn.id),
          streaming: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }
  }
  return messages;
}

function codexThreadTurnsWithinImportBoundary(
  turns: CodexThread["turns"],
  importThroughTurnId: string | null | undefined,
) {
  if (importThroughTurnId === undefined) {
    return turns;
  }
  if (importThroughTurnId === null) {
    return [];
  }

  const turnIndex = turns.findIndex((turn) => turn.id === importThroughTurnId);
  return turnIndex === -1 ? [] : turns.slice(0, turnIndex + 1);
}

export const readCodexProviderThread = (input: CodexProviderThreadRequest) =>
  withCodexAppServerClient(input, (client) =>
    client.request("thread/read", {
      threadId: input.providerThreadId,
      includeTurns: true,
    }),
  );

export const forkCodexProviderThread = (input: CodexProviderThreadForkRequest) =>
  withCodexAppServerClient(input, (client) =>
    Effect.gen(function* () {
      const forkResponse = yield* client.request("thread/fork", codexThreadForkParams(input));
      const extraTurnCount = codexTrailingTurnCountAfter(
        forkResponse.thread.turns,
        input.lastTurnId,
      );
      if (extraTurnCount === 0) {
        return forkResponse;
      }
      return yield* client.request("thread/rollback", {
        threadId: forkResponse.thread.id,
        numTurns: extraTurnCount,
      });
    }),
  );

export function codexThreadForkParams(input: {
  readonly providerThreadId: string;
  readonly cwd?: string;
  readonly lastTurnId?: string | null;
  readonly developerInstructions?: string;
}) {
  return {
    threadId: input.providerThreadId,
    ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
  };
}

export function codexTrailingTurnCountAfter(
  turns: ReadonlyArray<{ readonly id: string }>,
  lastTurnId: string | null | undefined,
): number {
  if (!lastTurnId) {
    return 0;
  }
  const turnIndex = turns.findIndex((turn) => turn.id === lastTurnId);
  return turnIndex === -1 ? 0 : Math.max(0, turns.length - turnIndex - 1);
}

function codexUserInputText(input: unknown): string {
  if (!input || typeof input !== "object" || !("type" in input)) {
    return "";
  }
  switch (input.type) {
    case "text":
      return "text" in input && typeof input.text === "string" ? input.text : "";
    case "mention":
      return "name" in input && typeof input.name === "string" ? `@${input.name}` : "";
    case "skill":
      return "name" in input && typeof input.name === "string" ? `$${input.name}` : "";
    case "image":
    case "localImage":
      return "";
    default:
      return "";
  }
}

function withCodexAppServerClient<A, E>(
  input: CodexProviderThreadRequest,
  request: (client: CodexClient.CodexAppServerClient["Service"]) => Effect.Effect<A, E>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const env = {
        ...input.environment,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      };
      const spawnCommand = yield* resolveSpawnCommand(
        input.binaryPath,
        CODEX_THREAD_BRIDGE_APP_SERVER_ARGS,
        {
          env,
          extendEnv: false,
        },
      );
      const child = yield* input.spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.configCwd,
          env,
          extendEnv: false,
          forceKillAfter: CODEX_THREAD_BRIDGE_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      );
      const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);
      return yield* request(client);
    }),
  );
}
