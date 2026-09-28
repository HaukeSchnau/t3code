import type { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  connectPairingUrl as connectPairingUrlAtom,
  updateBearerConnection,
} from "../../connection/onboarding";
import { unregisterAgentAwarenessDevice } from "../../state/agent-awareness";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspaceEnvironment, type WorkspaceEnvironment } from "../../state/workspaceModel";
import { commandFailure } from "../agent-awareness/registrationEnvironmentSelection";
import { unregisterAgentAwarenessDeviceFromEnvironment } from "../agent-awareness/remoteRegistration";

export interface RelayEnvironmentView {
  readonly environment: RelayClientEnvironmentRecord;
  readonly availability: "checking" | "online" | "offline" | "error";
  readonly status: RelayEnvironmentStatusResponse | null;
  readonly error: string | null;
  readonly traceId: string | null;
}

export function useConnectionController() {
  const { environments } = useEnvironments();
  const connectPairingUrlMutation = useAtomCommand(connectPairingUrlAtom, {
    reportFailure: false,
  });
  const updateBearer = useAtomCommand(updateBearerConnection, { reportFailure: false });
  const removeEnvironmentMutation = useAtomCommand(environmentCatalog.remove, "environment remove");
  const unregisterAgentAwareness = useAtomCommand(unregisterAgentAwarenessDevice, {
    reportFailure: false,
    reportDefect: false,
  });
  const retryEnvironmentMutation = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const setEnvironmentEnabledMutation = useAtomCommand(
    environmentCatalog.setEnabled,
    "environment toggle",
  );

  const connectedEnvironments = useMemo<ReadonlyArray<WorkspaceEnvironment>>(
    () => environments.map(projectWorkspaceEnvironment),
    [environments],
  );
  const connectPairingUrl = useCallback(
    (pairingUrl: string) => connectPairingUrlMutation(pairingUrl),
    [connectPairingUrlMutation],
  );
  const removeEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      // A removed server must stop pushing notifications and Live Activity updates here.
      await unregisterAgentAwarenessDeviceFromEnvironment(async (deviceId) => {
        const result = await unregisterAgentAwareness({ environmentId, input: { deviceId } });
        if (result._tag === "Failure") throw commandFailure(result);
      });
      return removeEnvironmentMutation(environmentId);
    },
    [removeEnvironmentMutation, unregisterAgentAwareness],
  );
  const retryEnvironment = useCallback(
    (environmentId: EnvironmentId) => retryEnvironmentMutation(environmentId),
    [retryEnvironmentMutation],
  );
  const setEnvironmentEnabled = useCallback(
    (environmentId: EnvironmentId, enabled: boolean) =>
      setEnvironmentEnabledMutation({ environmentId, enabled }),
    [setEnvironmentEnabledMutation],
  );
  const updateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) =>
      updateBearer({
        environmentId,
        label: updates.label,
        httpBaseUrl: updates.displayUrl,
      }),
    [updateBearer],
  );

  return {
    connectedEnvironments,
    connectPairingUrl,
    removeEnvironment,
    retryEnvironment,
    setEnvironmentEnabled,
    updateEnvironment,
  };
}
