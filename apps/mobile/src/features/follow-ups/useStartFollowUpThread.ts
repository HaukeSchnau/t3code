import { followUpSeedMessage } from "@t3tools/client-runtime/state/follow-ups";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type EnvironmentId,
  type FollowUp,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { appAtomRegistry } from "../../state/atom-registry";
import { followUpEnvironment } from "../../state/follow-ups";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";

export function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

/**
 * Starts a thread in `project` whose first message hands it the follow-up, with the project's
 * default model and modes in its checkout, then marks the follow-up picked up on its home.
 */
export function useStartFollowUpThread(input: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly followUp: FollowUp;
  readonly onSaved: (followUp: FollowUp) => void;
  readonly onStarted: (thread: { environmentId: EnvironmentId; threadId: ThreadId }) => void;
}) {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, {
    label: "follow-up start thread",
    reportFailure: false,
  });
  const save = useAtomCommand(followUpEnvironment.save, {
    label: "follow-up picked up",
    reportFailure: false,
  });
  const busy = useRef(false);
  const [starting, setStarting] = useState(false);

  const launch = async (project: EnvironmentProject) => {
    const environmentId = project.environmentId;
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    const modelSelection = scheduledTaskDefaultModel(config, project);
    if (modelSelection === null) {
      Dialog.alert("Could not start a thread", "That environment has no model to start with.");
      return;
    }
    const settings = resolveProjectSettings(
      config?.settings ?? DEFAULT_SERVER_SETTINGS,
      project.id,
      project,
    ).settings;
    const metadata = makeTurnCommandMetadata();
    const started = await startTurn({
      environmentId,
      input: buildProjectThreadStartTurnInput({
        ...metadata,
        projectId: project.id,
        projectCwd: project.workspaceRoot,
        text: followUpSeedMessage(input.followUp),
        titleText: input.followUp.title,
        uploadedAttachments: [],
        modelSelection,
        runtimeMode: settings.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
        worktreeBranchName: "",
      }),
    });
    const startFailure = failureMessage(started);
    if (startFailure !== null) Dialog.alert("Could not start a thread", startFailure);
    if (started._tag !== "Success") return;
    const threadId = ThreadId.make(metadata.threadId);
    const saved = await save({
      environmentId: input.homeEnvironmentId,
      input: {
        id: input.followUp.id,
        status: "picked_up",
        pickedUpThread: { environmentId, threadId },
      },
    });
    if (saved._tag === "Success") input.onSaved(saved.value);
    const saveFailure = failureMessage(saved);
    if (saveFailure !== null) {
      Dialog.alert("The thread started, but the follow-up still reads open", saveFailure);
    }
    input.onStarted({ environmentId, threadId });
  };

  const start = (project: EnvironmentProject) => {
    if (busy.current) return;
    if (!readEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope)) {
      Dialog.alert("Could not start a thread", "This device may not start threads there.");
      return;
    }
    busy.current = true;
    setStarting(true);
    void launch(project).finally(() => {
      busy.current = false;
      setStarting(false);
    });
  };

  return { start, starting };
}
