import { describe, expect, it, vi } from "vite-plus/test";
import { type AgentAwarenessRegistrationResult, EnvironmentId } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";

import {
  ownerEnvironmentIds,
  registrationEnvironmentIds,
  runFirstConfiguredRegistration,
} from "./registrationEnvironmentSelection";

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
  it("registers only with switched-on direct environments", () => {
    const environment = (id: string, isEnabled: boolean, isRelayManaged = false) => ({
      environmentId: EnvironmentId.make(id),
      isEnabled,
      isRelayManaged,
    });

    expect(
      registrationEnvironmentIds([
        environment("work", true),
        environment("personal", false),
        environment("relay", true, true),
      ]),
    ).toEqual(["work"]);
    expect(
      registrationEnvironmentIds([environment("work", true), environment("personal", true)]),
    ).toEqual(["personal", "work"]);
  });

  it("continues past an unconfigured server to one that can deliver APNs", async () => {
    const operation = vi.fn(async (environmentId: EnvironmentId) =>
      AsyncResult.success(environmentId === "environment-2" ? configured : unconfigured),
    );

    // The server that delivers owns the device, and the app icon reads its count.
    await expect(runFirstConfiguredRegistration(environmentIds, operation)).resolves.toEqual({
      ...configured,
      environmentId: "environment-2",
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("returns an unconfigured result only after trying every paired server", async () => {
    const operation = vi.fn(async () => AsyncResult.success(unconfigured));

    await expect(runFirstConfiguredRegistration(environmentIds, operation)).resolves.toEqual({
      ...unconfigured,
      environmentId: "environment-1",
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("reads the count only from the environment that owns the device while it is paired", () => {
    const [first, second] = environmentIds as [EnvironmentId, EnvironmentId];
    expect(ownerEnvironmentIds(environmentIds, second)).toEqual([second]);
    // Before the owner is known, or once it was removed, every paired server is a candidate.
    expect(ownerEnvironmentIds(environmentIds, null)).toEqual([first, second]);
    expect(ownerEnvironmentIds([first], second)).toEqual([first]);
  });
});
