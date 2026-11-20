import type { AgentAwarenessRegistrationResult, EnvironmentId } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";

export function commandFailure(result: { readonly cause: Cause.Cause<unknown> }): Error {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure : new Error(String(failure));
}

/** Switched-on direct environments, in the order registration tries them. */
export function registrationEnvironmentIds(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly isEnabled: boolean;
    readonly isRelayManaged: boolean;
  }>,
): EnvironmentId[] {
  return environments
    .filter((environment) => environment.isEnabled && !environment.isRelayManaged)
    .map((environment) => environment.environmentId)
    .sort();
}

/** A registration, with the environment that took it: it owns the device's pushes. */
export type OwnedRegistration = AgentAwarenessRegistrationResult & {
  readonly environmentId: EnvironmentId;
};

/**
 * Registers with the first environment that can deliver APNs, else the first that accepted, and
 * says which one.
 */
export async function runFirstConfiguredRegistration(
  environmentIds: readonly EnvironmentId[],
  operation: (
    environmentId: EnvironmentId,
  ) => Promise<AtomCommandResult<AgentAwarenessRegistrationResult, unknown>>,
): Promise<OwnedRegistration> {
  let unconfigured: OwnedRegistration | null = null;
  let lastError: Error | null = null;
  for (const environmentId of environmentIds) {
    const result = await operation(environmentId);
    if (result._tag === "Success") {
      if (result.value.deliveryConfigured) return { ...result.value, environmentId };
      unconfigured ??= { ...result.value, environmentId };
      continue;
    }
    lastError = commandFailure(result);
  }
  if (unconfigured) return unconfigured;
  throw lastError ?? new Error("No paired environment is available.");
}

/**
 * The environments the count and the Live Activity come from: the one that owns the device's
 * pushes while it is still paired, so the app icon never shows another server's number.
 */
export function ownerEnvironmentIds(
  environmentIds: readonly EnvironmentId[],
  owner: EnvironmentId | null,
): readonly EnvironmentId[] {
  return owner !== null && environmentIds.includes(owner) ? [owner] : environmentIds;
}
