import * as Schema from "effect/Schema";

import {
  RelayAgentActivitySnapshotResponse,
  RelayDeviceRegistrationRequest,
  RelayDeviceUnregistrationParams,
  RelayLiveActivityRegistrationRequest,
} from "./relay.ts";

export {
  RelayAgentActivitySnapshotResponse as AgentAwarenessSnapshot,
  RelayDeviceRegistrationRequest as AgentAwarenessDeviceRegistrationInput,
  RelayDeviceUnregistrationParams as AgentAwarenessDeviceUnregistrationInput,
  RelayLiveActivityRegistrationRequest as AgentAwarenessLiveActivityRegistrationInput,
};

export const AgentAwarenessRegistrationResult = Schema.Struct({
  accepted: Schema.Literal(true),
  deliveryConfigured: Schema.Boolean,
});
export type AgentAwarenessRegistrationResult = typeof AgentAwarenessRegistrationResult.Type;

export class AgentAwarenessServiceError extends Schema.TaggedErrorClass<AgentAwarenessServiceError>()(
  "AgentAwarenessServiceError",
  {
    message: Schema.String,
  },
) {}
