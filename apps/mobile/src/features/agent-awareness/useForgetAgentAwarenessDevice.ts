import type { EnvironmentId } from "@t3tools/contracts";

import { unregisterAgentAwarenessDevice } from "../../state/agent-awareness";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailure } from "./registrationEnvironmentSelection";
import { unregisterAgentAwarenessDeviceFromEnvironment } from "./remoteRegistration";

/**
 * Asks environments to forget this device before the phone disconnects from them,
 * so a removed or switched-off server stops sending notifications and Live Activity updates.
 */
export function useForgetAgentAwarenessDevice() {
  const unregister = useAtomCommand(unregisterAgentAwarenessDevice, {
    reportFailure: false,
    reportDefect: false,
  });
  return (environmentIds: Iterable<EnvironmentId>) =>
    Promise.all(
      Array.from(environmentIds, (environmentId) =>
        unregisterAgentAwarenessDeviceFromEnvironment(async (deviceId) => {
          const result = await unregister({ environmentId, input: { deviceId } });
          if (result._tag === "Failure") throw commandFailure(result);
        }),
      ),
    );
}
