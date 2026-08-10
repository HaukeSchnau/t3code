import { describe, expect, it, vi } from "vite-plus/test";
import { type AgentAwarenessRegistrationResult, EnvironmentId } from "@t3tools/contracts";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { runFirstConfiguredRegistration } from "./registrationEnvironmentSelection";

const unconfigured = {
  accepted: true as const,
  deliveryConfigured: false,
} satisfies AgentAwarenessRegistrationResult;
const configured = {
  accepted: true as const,
  deliveryConfigured: true,
} satisfies AgentAwarenessRegistrationResult;
const environmentIds = [EnvironmentId.make("environment-1"), EnvironmentId.make("environment-2")];

describe("accountless awareness environment selection", () => {
  it("continues past an unconfigured server to one that can deliver APNs", async () => {
    const operation = vi.fn(async (environmentId: EnvironmentId) =>
      AsyncResult.success(environmentId === "environment-2" ? configured : unconfigured),
    );

    await expect(runFirstConfiguredRegistration(environmentIds, operation)).resolves.toEqual(
      configured,
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("returns an unconfigured result only after trying every paired server", async () => {
    const operation = vi.fn(async () => AsyncResult.success(unconfigured));

    await expect(runFirstConfiguredRegistration(environmentIds, operation)).resolves.toEqual(
      unconfigured,
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
