/**
 * The fixture environment's identity, kept free of every other fixture import
 * so production modules can recognise it without pulling the scenario into
 * their bundle.
 */
import { EnvironmentId } from "@t3tools/contracts";

export const FIXTURE_ENVIRONMENT_ID = EnvironmentId.make("fixture-orchestration");
export const FIXTURE_ENVIRONMENT_LABEL = "Fixture";

export function isFixtureEnvironment(environmentId: string | null | undefined): boolean {
  return environmentId === FIXTURE_ENVIRONMENT_ID;
}
