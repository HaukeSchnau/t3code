import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  fallbackWorkspaceName,
  generateBootstrapWorkspaceNaming,
} from "./BootstrapWorkspaceNaming.ts";

const textGeneration = (
  generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"],
) =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused commit message generation"),
    generatePrContent: () => Effect.die("unused change request generation"),
    generateBranchName: () => Effect.die("unused branch name generation"),
    generateThreadTitle,
    generateNotification: () => Effect.die("unused notification generation"),
  });

it.effect("uses one generated title for the thread and workspace", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const result = yield* generateBootstrapWorkspaceNaming({
      threadId: ThreadId.make("thread-12345678"),
      cwd: "/repo/t3code",
      message: "What's the current logic for naming worktrees and dev instances?",
      provisionalTitle: "What's the current logic for naming worktrees an",
      textGeneration: textGeneration((input) => {
        expect(input.modelSelection).toEqual(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
        return Effect.succeed({ title: "Worktree Naming" });
      }),
      serverSettings,
    });

    expect(result).toEqual({
      threadTitle: "Worktree Naming",
      workspaceNameSeed: "Worktree Naming",
      generated: true,
    });
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);

it.effect("falls back to a stable opaque workspace name when generation fails", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const threadId = ThreadId.make("thread-12345678");
    const result = yield* generateBootstrapWorkspaceNaming({
      threadId,
      cwd: "/repo/t3code",
      message: "Please do a thing",
      provisionalTitle: "Please do a thing",
      textGeneration: textGeneration(() =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: "provider unavailable",
          }),
        ),
      ),
      serverSettings,
    });

    expect(result).toEqual({
      threadTitle: "Please do a thing",
      workspaceNameSeed: "task-12345678",
      generated: false,
    });
    expect(fallbackWorkspaceName(threadId)).toBe("task-12345678");
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);

it.effect("does not hold up workspace creation when generation times out", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const result = yield* generateBootstrapWorkspaceNaming({
      threadId: ThreadId.make("thread-timeout87654321"),
      cwd: "/repo/t3code",
      message: "A naming provider that never responds",
      provisionalTitle: "A naming provider that never responds",
      textGeneration: textGeneration(() => Effect.never),
      serverSettings,
      timeout: 0,
    });

    expect(result).toEqual({
      threadTitle: "A naming provider that never responds",
      workspaceNameSeed: "task-87654321",
      generated: false,
    });
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);
