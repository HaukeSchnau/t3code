import { homedir } from "node:os";
import { join } from "node:path";

import type { CodexSettings } from "@t3tools/contracts";
import { Data, Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";

import { expandHomePath } from "./pathExpansion.ts";
import { buildCodexInitializeParams } from "./provider/Layers/CodexProvider.ts";
import packageJson from "../package.json" with { type: "json" };

export const CODEX_VOICE_TRANSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/transcribe";
export const CODEX_VOICE_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface CodexVoiceTranscriptionResponse {
  readonly text: string;
}

export interface CodexVoiceAudioInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
}

export type CodexVoiceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CodexVoiceCredentials {
  readonly accessToken: string;
  readonly accountId: string;
}

export class CodexVoiceTranscriptionError extends Data.TaggedError("CodexVoiceTranscriptionError")<{
  readonly reason: "auth-unavailable" | "invalid-audio" | "upstream";
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const CodexAuthJsonSchema = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.String,
    account_id: Schema.String,
  }),
});

const TranscriptionResponseSchema = Schema.Struct({
  text: Schema.String,
});

export function resolveCodexVoiceAuthJsonPath(
  codexSettings: CodexSettings,
  pathService: Path.Path,
): string {
  const homePath = codexSettings.homePath.trim();
  return homePath
    ? pathService.join(expandHomePath(homePath), "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

export const readCodexVoiceCredentials = (
  codexSettings: CodexSettings,
): Effect.Effect<
  CodexVoiceCredentials,
  CodexVoiceTranscriptionError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const authJsonPath = resolveCodexVoiceAuthJsonPath(codexSettings, pathService);
    const raw = yield* fs.readFileString(authJsonPath).pipe(
      Effect.mapError(
        (cause) =>
          new CodexVoiceTranscriptionError({
            reason: "auth-unavailable",
            message: "Codex auth could not be found. Run `codex login` and try again.",
            cause,
          }),
      ),
    );
    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CodexAuthJsonSchema))(
      raw,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CodexVoiceTranscriptionError({
            reason: "auth-unavailable",
            message: "Codex auth is incomplete. Run `codex login` and try again.",
            cause,
          }),
      ),
    );

    const accessToken = parsed.tokens.access_token.trim();
    const accountId = parsed.tokens.account_id.trim();
    if (!accessToken || !accountId) {
      return yield* new CodexVoiceTranscriptionError({
        reason: "auth-unavailable",
        message: "Codex auth is incomplete. Run `codex login` and try again.",
      });
    }

    return { accessToken, accountId };
  });

export const refreshCodexVoiceAuth = (
  codexSettings: CodexSettings,
): Effect.Effect<void, CodexVoiceTranscriptionError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const clientContext = yield* Layer.build(
        CodexClient.layerCommand({
          command: codexSettings.binaryPath,
          args: ["app-server"],
          cwd: process.cwd(),
          ...(codexSettings.homePath.trim()
            ? { env: { CODEX_HOME: expandHomePath(codexSettings.homePath.trim()) } }
            : {}),
        }),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);
      yield* client.request("account/read", { refreshToken: true });
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new CodexVoiceTranscriptionError({
          reason: "auth-unavailable",
          message: "Codex auth refresh failed. Run `codex login` and try again.",
          cause,
        }),
    ),
  );

export interface CodexVoiceTranscriptionDependencies<R> {
  readonly fetch: CodexVoiceFetch;
  readonly refreshAuth: (
    codexSettings: CodexSettings,
  ) => Effect.Effect<void, CodexVoiceTranscriptionError, R>;
}

function codexDesktopUserAgent(): string {
  const platform = process.platform === "darwin" ? "Mac OS" : process.platform;
  return `Codex Desktop/${packageJson.version} (${platform} ${process.arch})`;
}

function validateAudio(input: CodexVoiceAudioInput) {
  if (input.bytes.byteLength === 0) {
    return new CodexVoiceTranscriptionError({
      reason: "invalid-audio",
      message: "Voice input did not contain any audio.",
      status: 400,
    });
  }
  if (input.bytes.byteLength > CODEX_VOICE_MAX_AUDIO_BYTES) {
    return new CodexVoiceTranscriptionError({
      reason: "invalid-audio",
      message: "Voice input is too large.",
      status: 400,
    });
  }
  return null;
}

const responseError = (status: number, cause?: unknown) =>
  new CodexVoiceTranscriptionError({
    reason: status === 401 ? "auth-unavailable" : "upstream",
    message:
      status === 401
        ? "Codex auth expired. Run `codex login` and try again."
        : "Codex transcription failed.",
    status,
    cause,
  });

const postTranscription = (
  fetchImpl: CodexVoiceFetch,
  audio: CodexVoiceAudioInput,
  credentials: CodexVoiceCredentials,
): Effect.Effect<CodexVoiceTranscriptionResponse, CodexVoiceTranscriptionError> =>
  Effect.tryPromise({
    try: async () => {
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(audio.bytes)], {
        type: audio.contentType || "application/octet-stream",
      });
      formData.append("file", blob, audio.filename || "voice.webm");

      const response = await fetchImpl(CODEX_VOICE_TRANSCRIPTION_ENDPOINT, {
        body: formData,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credentials.accessToken}`,
          "chatgpt-account-id": credentials.accountId,
          originator: "Codex Desktop",
          "user-agent": codexDesktopUserAgent(),
        },
        method: "POST",
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw responseError(response.status, bodyText);
      }

      const decoded = Schema.decodeUnknownSync(TranscriptionResponseSchema)(JSON.parse(bodyText));
      return { text: decoded.text.trim() };
    },
    catch: (cause) =>
      cause instanceof CodexVoiceTranscriptionError
        ? cause
        : new CodexVoiceTranscriptionError({
            reason: "upstream",
            message: "Codex transcription failed.",
            cause,
          }),
  });

export function makeTranscribeCodexVoiceAudio<R>(
  dependencies: CodexVoiceTranscriptionDependencies<R>,
) {
  return (
    audio: CodexVoiceAudioInput,
    codexSettings: CodexSettings,
  ): Effect.Effect<
    CodexVoiceTranscriptionResponse,
    CodexVoiceTranscriptionError,
    FileSystem.FileSystem | Path.Path | R
  > =>
    Effect.gen(function* () {
      const audioError = validateAudio(audio);
      if (audioError) {
        return yield* audioError;
      }

      const initialCredentials = yield* readCodexVoiceCredentials(codexSettings);
      const firstAttempt = yield* Effect.result(
        postTranscription(dependencies.fetch, audio, initialCredentials),
      );
      if (Result.isSuccess(firstAttempt)) {
        return firstAttempt.success;
      }
      const firstError = firstAttempt.failure;
      if (firstError.status !== 401) {
        return yield* firstError;
      }

      yield* dependencies.refreshAuth(codexSettings);
      const refreshedCredentials = yield* readCodexVoiceCredentials(codexSettings);
      return yield* postTranscription(dependencies.fetch, audio, refreshedCredentials);
    });
}

export const transcribeCodexVoiceAudio = makeTranscribeCodexVoiceAudio({
  fetch: (input, init) => globalThis.fetch(input, init),
  refreshAuth: refreshCodexVoiceAuth,
});
