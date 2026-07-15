import {
  NETWORK_LAB_RESULT_SCHEMA_VERSION,
  type PlannedScenarioStep,
  type ScenarioActionStep,
  type ScenarioCheckpointStep,
  type ScenarioExecutionPlan,
} from "./model.ts";
import {
  type CleanupEvidence,
  type CorrectnessEvidence,
  type FaultEvidence,
  type NetworkLabResult,
  type ObservationEvidence,
  type RunnerErrorEvidence,
  type RunnerPhase,
  type StepResult,
} from "./result.ts";

export interface NetworkLabAdapter {
  readonly prepare: (context: ScenarioExecutionPlan) => Promise<void>;
  readonly executeAction: (
    step: ScenarioActionStep,
    plannedStep: PlannedScenarioStep,
    context: ScenarioExecutionPlan,
  ) => Promise<ObservationEvidence>;
  readonly waitForCheckpoint: (
    step: ScenarioCheckpointStep,
    plannedStep: PlannedScenarioStep,
    context: ScenarioExecutionPlan,
  ) => Promise<ObservationEvidence>;
  readonly collectCorrectnessEvidence: (
    context: ScenarioExecutionPlan,
  ) => Promise<CorrectnessEvidence>;
  readonly collectFaultEvidence: (context: ScenarioExecutionPlan) => Promise<FaultEvidence>;
  readonly cleanup: (context: ScenarioExecutionPlan) => Promise<CleanupEvidence>;
}

function errorEvidence(
  phase: RunnerPhase,
  error: unknown,
  stepId: string | null = null,
): RunnerErrorEvidence {
  if (error instanceof Error) {
    return {
      phase,
      stepId,
      name: error.name || "Error",
      message: error.message || "Unknown error",
    };
  }
  return {
    phase,
    stepId,
    name: "UnknownError",
    message: String(error) || "Unknown error",
  };
}

async function collectCorrectness(
  adapter: NetworkLabAdapter,
  context: ScenarioExecutionPlan,
  errors: Array<RunnerErrorEvidence>,
): Promise<CorrectnessEvidence> {
  try {
    const evidence = await adapter.collectCorrectnessEvidence(context);
    return evidence.status === "passed" &&
      evidence.assertions.some((assertion) => !assertion.passed)
      ? { ...evidence, status: "failed" }
      : evidence;
  } catch (error) {
    errors.push(errorEvidence("correctness-evidence", error));
    return { status: "unavailable", assertions: [] };
  }
}

async function collectFault(
  adapter: NetworkLabAdapter,
  context: ScenarioExecutionPlan,
  errors: Array<RunnerErrorEvidence>,
): Promise<FaultEvidence> {
  try {
    const evidence = await adapter.collectFaultEvidence(context);
    return evidence.status === "passed" && !evidence.originPathUnshaped
      ? { ...evidence, status: "failed" }
      : evidence;
  } catch (error) {
    errors.push(errorEvidence("fault-evidence", error));
    return { status: "unavailable", originPathUnshaped: false, events: [] };
  }
}

async function cleanup(
  adapter: NetworkLabAdapter,
  context: ScenarioExecutionPlan,
  errors: Array<RunnerErrorEvidence>,
): Promise<CleanupEvidence> {
  try {
    const evidence = await adapter.cleanup(context);
    return evidence.status === "passed" && evidence.resources.some((resource) => !resource.released)
      ? { ...evidence, status: "failed" }
      : evidence;
  } catch (error) {
    errors.push(errorEvidence("cleanup", error));
    return { status: "failed", resources: [] };
  }
}

async function runStep(
  adapter: NetworkLabAdapter,
  context: ScenarioExecutionPlan,
  plannedStep: PlannedScenarioStep,
): Promise<ObservationEvidence> {
  return plannedStep.step.kind === "action"
    ? adapter.executeAction(plannedStep.step, plannedStep, context)
    : adapter.waitForCheckpoint(plannedStep.step, plannedStep, context);
}

export async function runNetworkLabScenario(
  context: ScenarioExecutionPlan,
  adapter: NetworkLabAdapter,
): Promise<NetworkLabResult> {
  const errors: Array<RunnerErrorEvidence> = [];
  const steps: Array<StepResult> = [];
  let executionFailed = false;

  try {
    await adapter.prepare(context);
  } catch (error) {
    executionFailed = true;
    errors.push(errorEvidence("prepare", error));
  }

  if (!executionFailed) {
    for (const plannedStep of context.steps) {
      try {
        const observation = await runStep(adapter, context, plannedStep);
        steps.push({
          id: plannedStep.step.id,
          sequence: plannedStep.sequence,
          decisionToken: plannedStep.decisionToken,
          kind: plannedStep.step.kind,
          status: "passed",
          observation,
        });
      } catch (error) {
        executionFailed = true;
        errors.push(errorEvidence("step", error, plannedStep.step.id));
        steps.push({
          id: plannedStep.step.id,
          sequence: plannedStep.sequence,
          decisionToken: plannedStep.decisionToken,
          kind: plannedStep.step.kind,
          status: "failed",
          observation: null,
        });
        break;
      }
    }
  }

  const correctness = await collectCorrectness(adapter, context, errors);
  const fault = await collectFault(adapter, context, errors);
  const cleanupEvidence = await cleanup(adapter, context, errors);
  const passed =
    !executionFailed &&
    errors.length === 0 &&
    correctness.status === "passed" &&
    fault.status === "passed" &&
    fault.originPathUnshaped &&
    cleanupEvidence.status === "passed";

  return {
    schemaVersion: NETWORK_LAB_RESULT_SCHEMA_VERSION,
    identity: context.identity,
    status: passed ? "passed" : "failed",
    steps,
    evidence: {
      correctness,
      fault,
      cleanup: cleanupEvidence,
    },
    errors,
  };
}
