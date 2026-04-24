import { randomUUID } from "node:crypto";
import { connect, constants as http2Constants } from "node:http2";
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

export interface CodexVoiceTranscriptionPostRequest {
  readonly audio: CodexVoiceAudioInput;
  readonly credentials: CodexVoiceCredentials;
  readonly userAgent: string;
}

export interface CodexVoiceTranscriptionPostResponse {
  readonly bodyText: string;
  readonly status: number;
}

export type CodexVoiceTranscriptionPost = (
  request: CodexVoiceTranscriptionPostRequest,
) => Promise<CodexVoiceTranscriptionPostResponse>;

export interface CodexVoiceCredentials {
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
  readonly postTranscription: CodexVoiceTranscriptionPost;
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

function escapeMultipartQuotedValue(value: string): string {
  return value.replace(/[\r\n"]/g, "_");
}

function escapeMultipartHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "_");
}

function makeMultipartBody(audio: CodexVoiceAudioInput, boundary: string): Buffer {
  const contentType = escapeMultipartHeaderValue(audio.contentType || "application/octet-stream");
  const filename = escapeMultipartQuotedValue(audio.filename || "voice.webm");
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([prefix, Buffer.from(audio.bytes), suffix]);
}

export const postCodexVoiceTranscriptionHttp2: CodexVoiceTranscriptionPost = ({
  audio,
  credentials,
  userAgent,
}) =>
  new Promise((resolve, reject) => {
    const endpoint = new URL(CODEX_VOICE_TRANSCRIPTION_ENDPOINT);
    const boundary = `----t3-codex-voice-${randomUUID()}`;
    const body = makeMultipartBody(audio, boundary);
    const client = connect(endpoint.origin, {
      ALPNProtocols: ["h2"],
    });

    let settled = false;
    const finish = (result: CodexVoiceTranscriptionPostResponse) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(result);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(cause);
    };

    client.once("error", fail);

    const request = client.request({
      ":method": "POST",
      ":path": `${endpoint.pathname}${endpoint.search}`,
      ":scheme": endpoint.protocol.slice(0, -1),
      ":authority": endpoint.host,
      accept: "application/json",
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      "content-length": String(body.byteLength),
      "content-type": `multipart/form-data; boundary=${boundary}`,
      originator: "Codex Desktop",
      "user-agent": userAgent,
    });

    const chunks: Buffer[] = [];
    let status = 0;

    request.once("response", (headers) => {
      const rawStatus = headers[":status"];
      status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus) || 0;
    });
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    request.once("error", fail);
    request.setTimeout(60_000, () => {
      request.close(http2Constants.NGHTTP2_CANCEL);
      fail(new Error("Codex transcription timed out."));
    });
    request.once("end", () => {
      finish({
        bodyText: Buffer.concat(chunks).toString("utf8"),
        status,
      });
    });
    request.end(body);
  });

const postTranscription = (
  postTranscriptionImpl: CodexVoiceTranscriptionPost,
  audio: CodexVoiceAudioInput,
  credentials: CodexVoiceCredentials,
): Effect.Effect<CodexVoiceTranscriptionResponse, CodexVoiceTranscriptionError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await postTranscriptionImpl({
        audio,
        credentials,
        userAgent: codexDesktopUserAgent(),
      });

      const bodyText = response.bodyText;
      if (response.status < 200 || response.status >= 300) {
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
        postTranscription(dependencies.postTranscription, audio, initialCredentials),
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
      return yield* postTranscription(dependencies.postTranscription, audio, refreshedCredentials);
    });
}

export const transcribeCodexVoiceAudio = makeTranscribeCodexVoiceAudio({
  postTranscription: postCodexVoiceTranscriptionHttp2,
  refreshAuth: refreshCodexVoiceAuth,
});
