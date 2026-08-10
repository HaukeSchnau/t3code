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
  unregisterAgentAwarenessDevice,
} from "../../state/agent-awareness";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  setAgentAwarenessEnvironmentTransport,
  type AgentAwarenessEnvironmentTransport,
} from "./remoteRegistration";
import { commandFailure, runFirstConfiguredRegistration } from "./registrationEnvironmentSelection";

export function AccountlessAgentAwarenessProvider(props: { readonly children: ReactNode }) {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentIds = useMemo(() => {
    const ids: EnvironmentId[] = [];
    for (const connection of Object.values(savedConnectionsById)) {
      if (connection.relayManaged !== true) ids.push(connection.environmentId);
    }
    return ids.sort();
  }, [savedConnectionsById]);
  const registerDevice = useAtomCommand(registerAgentAwarenessDevice, {
    reportFailure: false,
    reportDefect: false,
  });
  const unregisterDevice = useAtomCommand(unregisterAgentAwarenessDevice, {
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

  useEffect(() => {
    if (environmentIds.length === 0) {
      setAgentAwarenessEnvironmentTransport(null);
      return;
    }
    const runFirst = async <A,>(
      operation: (environmentId: EnvironmentId) => Promise<AtomCommandResult<A, unknown>>,
    ): Promise<A> => {
      let lastError: Error | null = null;
      for (const environmentId of environmentIds) {
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
      unregisterDevice: async (deviceId: string) => {
        const results = await Promise.all(
          environmentIds.map((environmentId) =>
            unregisterDevice({ environmentId, input: { deviceId } }),
          ),
        );
        const failure = results.find((result) => result._tag === "Failure");
        if (failure) throw commandFailure(failure);
      },
      registerLiveActivity: (input: AgentAwarenessLiveActivityRegistrationInput) =>
        runFirstConfiguredRegistration(environmentIds, (environmentId) =>
          registerLiveActivity({ environmentId, input }),
        ),
      getSnapshot: () =>
        runFirst<AgentAwarenessSnapshot>((environmentId) =>
          getSnapshot({ environmentId, input: {} }),
        ),
    };
    setAgentAwarenessEnvironmentTransport(transport);
    return () => {
      setAgentAwarenessEnvironmentTransport(null);
    };
  }, [environmentIds, getSnapshot, registerDevice, registerLiveActivity, unregisterDevice]);

  return props.children;
}
