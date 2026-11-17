import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";
import { unregisterAgentAwarenessDevice } from "../../state/agent-awareness";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailure } from "./registrationEnvironmentSelection";
import { unregisterAgentAwarenessDeviceFromEnvironment } from "./remoteRegistration";

/**
 * Asks switched-on environments to forget this device before the phone disconnects from them,
 * so a removed or switched-off server stops sending notifications and Live Activity updates.
 * A switched-off environment already forgot it and is unreachable. Skipping it also keeps every
 * forget followed by a change to the registration environments, which starts a fresh registration.
 */
export function useForgetAgentAwarenessDevice() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const unregister = useAtomCommand(unregisterAgentAwarenessDevice, {
    reportFailure: false,
    reportDefect: false,
  });
  return (environmentIds: Iterable<EnvironmentId>) =>
    Promise.all(
      Array.from(environmentIds)
        .filter((environmentId) => catalog.entries.get(environmentId)?.enabled === true)
        .map((environmentId) =>
          unregisterAgentAwarenessDeviceFromEnvironment(async (deviceId) => {
            const result = await unregister({ environmentId, input: { deviceId } });
            if (result._tag === "Failure") throw commandFailure(result);
          }),
        ),
    );
}
