import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CodexSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Result } from "effect";

import {
  CodexVoiceTranscriptionError,
  type CodexVoiceTranscriptionPost,
  makeTranscribeCodexVoiceAudio,
  readCodexVoiceCredentials,
} from "./codexVoiceTranscription.ts";

const codexSettings = (homePath: string): CodexSettings => ({
  binaryPath: "codex",
  customModels: [],
  enabled: true,
  homePath,
  shadowHomePath: homePath,
});

const writeAuthJson = (homePath: string, accessToken: string, accountId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(homePath, { recursive: true });
    yield* fs.writeFileString(
      path.join(homePath, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          account_id: accountId,
        },
      }),
    );
  });

it.layer(NodeServices.layer)("codex voice transcription", (it) => {
  it.effect("reads Codex auth from the configured home path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-auth-" });
      yield* writeAuthJson(homePath, "secret-token", "account-1");

      const seenRequests: Parameters<CodexVoiceTranscriptionPost>[0][] = [];
      const transcribe = makeTranscribeCodexVoiceAudio({
        postTranscription: async (request) => {
          seenRequests.push(request);
          return { bodyText: JSON.stringify({ text: " hello world " }), status: 200 };
        },
        refreshAuth: () => Effect.void,
      });

      const result = yield* transcribe(
        {
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "audio/webm",
          filename: "voice.webm",
        },
        codexSettings(homePath),
      );

      assert.deepEqual(result, { text: "hello world" });
      assert.equal(seenRequests[0]?.credentials.accessToken, "secret-token");
      assert.equal(seenRequests[0]?.credentials.accountId, "account-1");
      assert.match(seenRequests[0]?.userAgent ?? "", /^Codex Desktop\//);
    }),
  );

  it.effect("rejects missing or incomplete Codex auth", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-missing-auth-" });
      const missing = yield* Effect.result(readCodexVoiceCredentials(codexSettings(homePath)));
      assert.isTrue(Result.isFailure(missing));

      yield* writeAuthJson(homePath, "", "");
      const incomplete = yield* Effect.result(readCodexVoiceCredentials(codexSettings(homePath)));
      assert.isTrue(Result.isFailure(incomplete));
      if (Result.isFailure(incomplete)) {
        assert.instanceOf(incomplete.failure, CodexVoiceTranscriptionError);
        assert.equal(incomplete.failure.reason, "auth-unavailable");
      }
    }),
  );

  it.effect("retries once after unauthorized transcription and refreshes auth", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-refresh-auth-" });
      yield* writeAuthJson(homePath, "old-token", "account-1");

      const seenAuthorizations: string[] = [];
      let refreshCount = 0;
      const transcribe = makeTranscribeCodexVoiceAudio({
        postTranscription: async ({ credentials }) => {
          seenAuthorizations.push(`Bearer ${credentials.accessToken}`);
          return seenAuthorizations.length === 1
            ? { bodyText: "expired", status: 401 }
            : { bodyText: JSON.stringify({ text: " refreshed transcript " }), status: 200 };
        },
        refreshAuth: () =>
          Effect.gen(function* () {
            refreshCount += 1;
            yield* writeAuthJson(homePath, "new-token", "account-1");
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CodexVoiceTranscriptionError({
                  reason: "auth-unavailable",
                  message: "Codex auth refresh failed. Run `codex login` and try again.",
                  cause,
                }),
            ),
          ),
      });

      const result = yield* transcribe(
        {
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "audio/webm",
          filename: "voice.webm",
        },
        codexSettings(homePath),
      );

      assert.deepEqual(result, { text: "refreshed transcript" });
      assert.deepEqual(seenAuthorizations, ["Bearer old-token", "Bearer new-token"]);
      assert.equal(refreshCount, 1);
    }),
  );

  it.effect("returns a sanitized error for upstream failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-upstream-auth-" });
      yield* writeAuthJson(homePath, "secret-token", "account-1");
      const transcribe = makeTranscribeCodexVoiceAudio({
        postTranscription: (async () => ({
          bodyText: "upstream saw secret-token",
          status: 500,
        })) satisfies CodexVoiceTranscriptionPost,
        refreshAuth: () => Effect.void,
      });

      const result = yield* Effect.result(
        transcribe(
          {
            bytes: new Uint8Array([1, 2, 3]),
            contentType: "audio/webm",
            filename: "voice.webm",
          },
          codexSettings(homePath),
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.message, "Codex transcription failed.");
        assert.notInclude(result.failure.message, "secret-token");
      }
    }),
  );
});
