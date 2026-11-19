import type {
  AgentAwarenessDeviceRegistrationInput,
  AgentAwarenessLiveActivityRegistrationInput,
  AgentAwarenessSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { type ReactNode, useEffect, useMemo } from "react";

import {
  getAgentAwarenessSnapshot,
  registerAgentAwarenessDevice,
  registerAgentAwarenessLiveActivity,
} from "../../state/agent-awareness";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  releaseAgentAwarenessEnvironmentTransport,
  retryAgentAwarenessRegistration,
  setAgentAwarenessEnvironmentTransport,
  type AgentAwarenessEnvironmentTransport,
} from "./remoteRegistration";
import {
  commandFailure,
  ownerEnvironmentIds,
  registrationEnvironmentIds,
  runFirstConfiguredRegistration,
} from "./registrationEnvironmentSelection";

export function AccountlessAgentAwarenessProvider(props: { readonly children: ReactNode }) {
  const { isLoadingSavedConnection } = useSavedRemoteConnections();
  const environments = useWorkspaceEnvironments();
  const environmentKey = registrationEnvironmentIds(environments).join("|");
  const connectedKey = registrationEnvironmentIds(
    environments.filter((environment) => environment.connectionState === "connected"),
  ).join("|");
  const environmentIds = useMemo(
    () => (environmentKey === "" ? [] : (environmentKey.split("|") as EnvironmentId[])),
    [environmentKey],
  );
  const registerDevice = useAtomCommand(registerAgentAwarenessDevice, {
    reportFailure: false,
    reportDefect: false,
  });
  const registerLiveActivity = useAtomCommand(registerAgentAwarenessLiveActivity, {
    reportFailure: false,
    reportDefect: false,
  });
  const getSnapshot = useAtomCommand(getAgentAwarenessSnapshot, {
    reportFailure: false,
    reportDefect: false,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the transport to a module-level registration owner and withdraws it on unmount.
  useEffect(() => {
    if (isLoadingSavedConnection) return;
    if (environmentIds.length === 0) {
      setAgentAwarenessEnvironmentTransport(null);
      return;
    }
    const runFirst = async <A,>(
      candidates: readonly EnvironmentId[],
      operation: (environmentId: EnvironmentId) => Promise<AtomCommandResult<A, unknown>>,
    ): Promise<A> => {
      let lastError: Error | null = null;
      for (const environmentId of candidates) {
        const result = await operation(environmentId);
        if (result._tag === "Success") return result.value;
        lastError = commandFailure(result);
      }
      throw lastError ?? new Error("No paired environment is available.");
    };
    const transport: AgentAwarenessEnvironmentTransport = {
      identity: environmentIds.join("|"),
      registerDevice: (input: AgentAwarenessDeviceRegistrationInput) =>
        runFirstConfiguredRegistration(environmentIds, (environmentId) =>
          registerDevice({ environmentId, input }),
        ),
      registerLiveActivity: (input: AgentAwarenessLiveActivityRegistrationInput, owner) =>
        runFirstConfiguredRegistration(
          ownerEnvironmentIds(environmentIds, owner),
          (environmentId) => registerLiveActivity({ environmentId, input }),
        ),
      getSnapshot: (owner) =>
        runFirst<AgentAwarenessSnapshot>(
          ownerEnvironmentIds(environmentIds, owner),
          (environmentId) => getSnapshot({ environmentId, input: {} }),
        ),
    };
    setAgentAwarenessEnvironmentTransport(transport);
    return releaseAgentAwarenessEnvironmentTransport;
  }, [environmentIds, getSnapshot, isLoadingSavedConnection, registerDevice, registerLiveActivity]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registration right after launch or a switch-on runs before the environment connects, so retry once it does.
  useEffect(() => {
    if (connectedKey !== "") retryAgentAwarenessRegistration();
  }, [connectedKey]);

  return props.children;
}
