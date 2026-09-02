import type { ChatAttachment, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSettings from "../serverSettings.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { DEFAULT_THREAD_TITLE } from "../orchestration/threadTitles.ts";

export const BOOTSTRAP_WORKSPACE_NAMING_TIMEOUT = Duration.seconds(5);

export interface BootstrapWorkspaceNaming {
  readonly threadTitle: string;
  readonly workspaceNameSeed: string;
  readonly generated: boolean;
}

/** A stable, non-misleading fallback when semantic naming is unavailable. */
export function fallbackWorkspaceName(threadId: ThreadId): string {
  const suffix = threadId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `task-${suffix || "workspace"}`;
}

/**
 * Generates the first thread title early enough to name its workspace too. Failure and timeout
 * deliberately preserve the provisional UI title while using an opaque workspace name.
 */
export const generateBootstrapWorkspaceNaming = Effect.fn("BootstrapWorkspaceNaming.generate")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly message: string;
    readonly provisionalTitle: string;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    readonly textGeneration: TextGeneration.TextGeneration["Service"];
    readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
    readonly timeout?: Duration.Input | undefined;
  }) {
    const generated = yield* Effect.gen(function* () {
      const settings = yield* input.serverSettings.getSettings;
      return yield* input.textGeneration.generateThreadTitle({
        cwd: input.cwd,
        message: input.message,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        modelSelection: settings.textGenerationModelSelection,
      });
    }).pipe(
      Effect.timeoutOption(input.timeout ?? BOOTSTRAP_WORKSPACE_NAMING_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to generate bootstrap workspace name", {
          threadId: input.threadId,
          cause,
        }).pipe(Effect.as(Option.none())),
      ),
    );

    if (Option.isSome(generated)) {
      const title = generated.value.title.trim();
      if (title.length > 0 && title !== DEFAULT_THREAD_TITLE) {
        return {
          threadTitle: title,
          workspaceNameSeed: title,
          generated: true,
        } satisfies BootstrapWorkspaceNaming;
      }
    }

    return {
      threadTitle: input.provisionalTitle,
      workspaceNameSeed: fallbackWorkspaceName(input.threadId),
      generated: false,
    } satisfies BootstrapWorkspaceNaming;
  },
);
