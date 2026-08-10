import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const registerAgentAwarenessDevice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:agent-awareness:register-device",
  tag: WS_METHODS.agentAwarenessRegisterDevice,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

export const unregisterAgentAwarenessDevice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:agent-awareness:unregister-device",
  tag: WS_METHODS.agentAwarenessUnregisterDevice,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

export const registerAgentAwarenessLiveActivity = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  {
    label: "mobile:agent-awareness:register-live-activity",
    tag: WS_METHODS.agentAwarenessRegisterLiveActivity,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  },
);

export const getAgentAwarenessSnapshot = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:agent-awareness:get-snapshot",
  tag: WS_METHODS.agentAwarenessGetSnapshot,
  concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
});
