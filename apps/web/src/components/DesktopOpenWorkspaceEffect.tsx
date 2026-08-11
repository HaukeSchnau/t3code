import { useEffect, useEffectEvent, useRef } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DesktopOpenWorkspaceRequest } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { readEnvironmentApi } from "../environmentApi";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { usePrimarySettings } from "../hooks/useSettings";
import { newCommandId, newProjectId } from "../lib/utils";
import { openWorkspaceInApp } from "../lib/openWorkspaceInApp";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";

function buildDesktopOpenWorkspaceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export function DesktopOpenWorkspaceEffect() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bootstrapComplete = primaryEnvironmentId !== null;
  const { handleNewThread } = useHandleNewThread();
  const settings = usePrimarySettings((state) => ({
    defaultThreadEnvMode: state.defaultThreadEnvMode,
    sidebarThreadSortOrder: state.sidebarThreadSortOrder,
  }));
  const projects = useProjects();
  const threads = useThreadShells();
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
      newCommandId,
      newProjectId,
      dispatchCreateProject: async (command) => {
        await api.orchestration.dispatchCommand(command);
      },
      handleNewThread: async (projectRef, options) => {
        await handleNewThread(projectRef, options);
      },
      navigateToThread: async (threadRef) => {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      },
    });
  });

  const resumeCodexThreadRequest = useEffectEvent(async (threadId: string) => {
    if (!primaryEnvironmentId) {
      throw new Error("Local environment is not ready yet.");
    }

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) {
      throw new Error("Local environment is not ready yet.");
    }

    const result = await api.codex.resumeThread({ threadId });
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(primaryEnvironmentId, result.threadId)),
    });
  });

  const enqueueWorkspaceRequest = useEffectEvent((request: DesktopOpenWorkspaceRequest) => {
    requestQueueRef.current = requestQueueRef.current
      .then(() => {
        switch (request.type) {
          case "open-workspace":
            return openWorkspaceRequest(request.cwd);
          case "codex-thread-resume":
            return resumeCodexThreadRequest(request.threadId);
        }
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              request.type === "codex-thread-resume"
                ? "Unable to resume Codex thread"
                : "Unable to open workspace",
            description: buildDesktopOpenWorkspaceErrorMessage(error),
          }),
        );
      });
  });

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !primaryEnvironmentId || !bootstrapComplete) {
      return;
    }

    const unsubscribe = bridge.onOpenWorkspaceRequest((request) => {
      enqueueWorkspaceRequest(request);
    });

    if (!consumedInitialRequestsRef.current) {
      consumedInitialRequestsRef.current = true;
      void bridge
        .consumePendingOpenWorkspaceRequests()
        .then((requests) => {
          for (const request of requests) {
            enqueueWorkspaceRequest(request);
          }
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open workspace",
              description: buildDesktopOpenWorkspaceErrorMessage(error),
            }),
          );
        });
    }

    return () => {
      unsubscribe?.();
    };
  }, [bootstrapComplete, enqueueWorkspaceRequest, primaryEnvironmentId]);

  return null;
}
