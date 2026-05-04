import { useEffect, useEffectEvent, useRef } from "react";
import {
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type ProjectId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { openWorkspaceInApp } from "../lib/openWorkspaceInApp";
import { newCommandId, newProjectId } from "../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { toastManager } from "./ui/toast";

function buildDesktopOpenWorkspaceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export function DesktopOpenWorkspaceEffect() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bootstrapComplete = useStore((state) =>
    primaryEnvironmentId
      ? (state.environmentStateById[primaryEnvironmentId]?.bootstrapComplete ?? false)
      : false,
  );
  const { handleNewThread } = useHandleNewThread();
  const settings = useSettings((state) => ({
    defaultThreadEnvMode: state.defaultThreadEnvMode,
    sidebarThreadSortOrder: state.sidebarThreadSortOrder,
  }));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const consumedInitialRequestsRef = useRef(false);
  const requestQueueRef = useRef(Promise.resolve());

  const openWorkspaceRequest = useEffectEvent(async (cwd: string) => {
    if (!primaryEnvironmentId) {
      throw new Error("Local environment is not ready yet.");
    }

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) {
      throw new Error("Local environment is not ready yet.");
    }

    await openWorkspaceInApp({
      environmentId: primaryEnvironmentId,
      environmentPlatform: navigator.platform,
      rawCwd: cwd,
      currentProjectCwd: null,
      projects,
      threads,
      sidebarThreadSortOrder: settings.sidebarThreadSortOrder,
      defaultThreadEnvMode: settings.defaultThreadEnvMode,
      createProject: async (input): Promise<ProjectId> => {
        const projectId = newProjectId();
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title: input.title,
          workspaceRoot: input.cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: {
            instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
            model: DEFAULT_MODEL,
          },
          createdAt: new Date().toISOString(),
        });
        return projectId;
      },
      handleNewThread,
      navigateToThread: async (threadRef) => {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      },
    });
  });

  const enqueueWorkspaceRequest = useEffectEvent((cwd: string) => {
    requestQueueRef.current = requestQueueRef.current
      .then(() => openWorkspaceRequest(cwd))
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open workspace",
          description: buildDesktopOpenWorkspaceErrorMessage(error),
        });
      });
  });

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !primaryEnvironmentId || !bootstrapComplete) {
      return;
    }

    const unsubscribe = bridge.onOpenWorkspaceRequest((request) => {
      enqueueWorkspaceRequest(request.cwd);
    });

    if (!consumedInitialRequestsRef.current) {
      consumedInitialRequestsRef.current = true;
      void bridge
        .consumePendingOpenWorkspaceRequests()
        .then((requests) => {
          for (const request of requests) {
            enqueueWorkspaceRequest(request.cwd);
          }
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Unable to open workspace",
            description: buildDesktopOpenWorkspaceErrorMessage(error),
          });
        });
    }

    return () => {
      unsubscribe?.();
    };
  }, [bootstrapComplete, primaryEnvironmentId]);

  return null;
}
