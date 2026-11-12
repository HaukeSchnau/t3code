import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { followUpSeedMessage } from "@t3tools/client-runtime/state/follow-ups";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId, type FollowUp } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";

import { newMessageId, newThreadId } from "~/lib/utils";
import { resolveProjectDefaultProviderModelSelection } from "~/providerInstances";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { followUpEnvironment } from "~/state/followUps";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { DEFAULT_INTERACTION_MODE } from "~/types";
import { toastManager } from "../ui/toast";

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * Starts a thread on a follow-up in `project` with the project's default model and modes, marks
 * the follow-up picked up on its home, and opens the thread. Resolves whether the thread started.
 */
export function useStartFollowUpThread() {
  const navigate = useNavigate();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const save = useAtomCommand(followUpEnvironment.save, { reportFailure: false });
  return async (input: {
    readonly homeEnvironmentId: EnvironmentId;
    readonly followUp: FollowUp;
    readonly project: EnvironmentProject;
  }): Promise<boolean> => {
    const { followUp, project } = input;
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId);
    const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
    const providers = config?.providers ?? [];
    const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
    const { selection: modelSelection } = resolveNewThreadModelSelection({
      defaultSelection:
        projectSettings.defaultModelSelection ??
        resolveProjectDefaultProviderModelSelection(providers, settings, project.id),
      fallbackSelection: settings.fallbackModelSelection ?? null,
      providers,
      settings,
      projectId: project.id,
      now: Date.now(),
    });
    if (modelSelection === null) {
      toastManager.add({
        type: "error",
        title: "Could not start a thread",
        description: "No model is ready for this project. Set one up in Settings, Providers.",
      });
      return false;
    }
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const runtimeMode = projectSettings.defaultRuntimeMode;
    const started = await startTurn({
      environmentId: project.environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: followUpSeedMessage(followUp),
          attachments: [],
        },
        modelSelection,
        runtimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        bootstrap: {
          createThread: {
            projectId: project.id,
            title: followUp.title.trim() || "Follow-up",
            modelSelection,
            runtimeMode,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
        createdAt,
      },
    });
    if (started._tag === "Failure") {
      if (!isAtomCommandInterrupted(started)) {
        toastManager.add({
          type: "error",
          title: "Could not start a thread",
          description: failureMessage(squashAtomCommandFailure(started), "An error occurred."),
        });
      }
      return false;
    }
    const pickedUp = await save({
      environmentId: input.homeEnvironmentId,
      input: {
        id: followUp.id,
        status: "picked_up",
        pickedUpThread: { environmentId: project.environmentId, threadId },
      },
    });
    if (pickedUp._tag === "Failure" && !isAtomCommandInterrupted(pickedUp)) {
      toastManager.add({
        type: "warning",
        title: "The thread started, but the follow-up is still open",
        description: failureMessage(squashAtomCommandFailure(pickedUp), "An error occurred."),
      });
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(project.environmentId, threadId)),
    });
    return true;
  };
}
