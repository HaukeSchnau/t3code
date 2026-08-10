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

export async function runFirstConfiguredRegistration(
  environmentIds: readonly EnvironmentId[],
  operation: (
    environmentId: EnvironmentId,
  ) => Promise<AtomCommandResult<AgentAwarenessRegistrationResult, unknown>>,
): Promise<AgentAwarenessRegistrationResult> {
  let unconfiguredResult: AgentAwarenessRegistrationResult | null = null;
  let lastError: Error | null = null;
  for (const environmentId of environmentIds) {
    const result = await operation(environmentId);
    if (result._tag === "Success") {
      if (result.value.deliveryConfigured) return result.value;
      unconfiguredResult ??= result.value;
      continue;
    }
    lastError = commandFailure(result);
  }
  if (unconfiguredResult) return unconfiguredResult;
  throw lastError ?? new Error("No paired environment is available.");
}
