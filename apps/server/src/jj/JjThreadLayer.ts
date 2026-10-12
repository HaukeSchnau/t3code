/**
 * A per-thread jj config layer. Providers that run one process per thread get
 * `JJ_CONFIG` pointing at the user's config followed by this layer, so the
 * agent's own `jj commit`, `describe` and `new -m` add T3-Thread and T3-Turn
 * trailers, and every jj operation it runs is tagged with the thread and turn.
 * T3 rewrites the layer when each turn starts.
 *
 * On launcher hosts agent-exec owns the agent's environment and home, so the
 * layer would hide the agent's own jj config. Those agents only get
 * `JJ_OP_USERNAME`, and T3 adds trailers after the turn instead.
 *
 * @module JjThreadLayer
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { JJ_THREAD_TRAILER, JJ_TURN_TRAILER } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { ProviderThreadEnvironment } from "../orchestration-v2/ProviderThreadEnvironment.ts";
import * as JjCli from "../vcs/JjCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjString } from "../vcs/JjVcsDriver.ts";
import { encodeJsonString } from "./jjTemplateJson.ts";

export class JjThreadLayer extends Context.Service<
  JjThreadLayer,
  {
    /** Environment variables for a provider process that serves only this thread. */
    readonly environmentFor: (threadId: string) => Effect.Effect<Readonly<Record<string, string>>>;
    /** Rewrites the thread's layer for the turn about to start. */
    readonly writeForTurn: (input: {
      readonly threadId: string;
      readonly ordinal: number;
      readonly trailers: boolean;
    }) => Effect.Effect<void>;
  }
>()("t3/jj/JjThreadLayer") {}

/** The operation username that tags a thread's jj operations. */
export const operationUsername = (threadId: string, ordinal?: number) =>
  ordinal === undefined ? `t3:${threadId}` : `t3:${threadId}:${ordinal}`;

const trailerTemplate = (threadId: string, ordinal: number) =>
  jjString(`${JJ_THREAD_TRAILER}: ${threadId}\n${JJ_TURN_TRAILER}: ${ordinal}`);

/** The layer's TOML. */
function renderThreadLayer(input: {
  readonly threadId: string;
  readonly ordinal: number;
  readonly trailers: boolean;
  readonly userTrailerTemplate: string;
}): string {
  const ours = trailerTemplate(input.threadId, input.ordinal);
  const template =
    input.userTrailerTemplate.trim().length > 0
      ? `(${input.userTrailerTemplate.trim()}) ++ "\\n" ++ ${ours}`
      : ours;
  return [
    `# Managed by T3 Code for thread ${input.threadId}. Rewritten when each turn starts.`,
    ...(input.trailers ? ["[templates]", `commit_trailers = ${encodeJsonString(template)}`] : []),
    "[operation]",
    `username = ${encodeJsonString(operationUsername(input.threadId, input.ordinal))}`,
    "",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const launcherHost = (process.env.T3CODE_EXECUTION_LAUNCHER ?? "").trim().length > 0;

  const layerPath = (threadId: string) =>
    path.join(
      stateDir,
      "jj",
      "threads",
      `${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 16)}.toml`,
    );

  const jjGlobal = (operation: string, args: ReadonlyArray<string>) =>
    vcsProcess
      .run({
        operation,
        command: "jj",
        args: [...JjCli.STABLE_OUTPUT_ARGS, ...args],
        cwd: globalThis.process.cwd(),
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
      );

  // Setting JJ_CONFIG replaces jj's default config lookup, so the user's own
  // files go first. Missing paths are skipped by jj.
  const userConfigPaths = yield* Effect.cached(
    Effect.gen(function* () {
      const explicit = process.env.JJ_CONFIG;
      if (explicit !== undefined) return explicit.split(":").filter((entry) => entry.length > 0);
      // One path per line: ~/.jjconfig.toml, ~/.config/jj/config.toml and conf.d when present.
      return (yield* jjGlobal("JjThreadLayer.userConfigPath", ["config", "path", "--user"]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }),
  );

  const userTrailerTemplate = jjGlobal("JjThreadLayer.userTrailerTemplate", [
    "config",
    "get",
    "templates.commit_trailers",
  ]);

  const write = (threadId: string, contents: string) => {
    const file = layerPath(threadId);
    const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    return fileSystem.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(temporary, contents)),
      Effect.andThen(fileSystem.rename(temporary, file)),
      Effect.catch((cause) =>
        Effect.logWarning("could not write the thread's jj config layer", {
          threadId,
          cause: cause.message,
        }),
      ),
    );
  };

  const environmentFor: JjThreadLayer["Service"]["environmentFor"] = (threadId) =>
    Effect.gen(function* () {
      if (launcherHost) return { JJ_OP_USERNAME: operationUsername(threadId) };
      const file = layerPath(threadId);
      if (!(yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
        yield* write(
          threadId,
          `[operation]\nusername = ${encodeJsonString(operationUsername(threadId))}\n`,
        );
      }
      return { JJ_CONFIG: [...(yield* userConfigPaths), file].join(":") };
    });

  const writeForTurn: JjThreadLayer["Service"]["writeForTurn"] = (input) =>
    launcherHost
      ? Effect.void
      : Effect.gen(function* () {
          yield* write(
            input.threadId,
            renderThreadLayer({ ...input, userTrailerTemplate: yield* userTrailerTemplate }),
          );
        });

  return JjThreadLayer.of({ environmentFor, writeForTurn });
});

export const layer = Layer.effect(JjThreadLayer, make);

/** Gives per-thread provider processes the thread's jj layer. */
export const providerEnvironmentLayer = Layer.effect(
  ProviderThreadEnvironment,
  Effect.gen(function* () {
    const threadLayer = yield* JjThreadLayer;
    return { forThread: threadLayer.environmentFor };
  }),
);
