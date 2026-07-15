import {
  NETWORK_LAB_RESULT_SCHEMA_VERSION,
  type CleanupResource,
  type NetworkLabProvenance,
  type PlannedScenarioStep,
  type ResourceLease,
  type ScenarioActionStep,
  type ScenarioCheckpointStep,
  type ScenarioControlStep,
  type ScenarioExecutionPlan,
} from "./model.ts";
import {
  type CleanupEvidence,
  type CleanupResourceEvidence,
  type CorrectnessEvidence,
  type FaultEvidence,
  type NetworkLabResult,
  type ObservationEvidence,
  type PassedCleanupResourceEvidence,
  type RunnerErrorEvidence,
  type RunnerPhase,
  type StepResult,
} from "./result.ts";
import { canonicalJson } from "./scenario.ts";

export interface AdapterOperation {
  readonly signal: AbortSignal;
  readonly lease: ResourceLease | null;
}

export interface NetworkLabAdapter {
  readonly provenance: NetworkLabProvenance;
  readonly prepare: (
    context: ScenarioExecutionPlan,
    operation: AdapterOperation,
  ) => Promise<ResourceLease>;
  readonly executeAction: (
    step: ScenarioActionStep,
    plannedStep: PlannedScenarioStep,
    context: ScenarioExecutionPlan,
    operation: AdapterOperation,
  ) => Promise<ObservationEvidence>;
  readonly executeControl: (
    step: ScenarioControlStep,
    plannedStep: PlannedScenarioStep,
    context: ScenarioExecutionPlan,
    operation: AdapterOperation,
  ) => Promise<ObservationEvidence>;
  readonly waitForCheckpoint: (
    step: ScenarioCheckpointStep,
    plannedStep: PlannedScenarioStep,
    context: ScenarioExecutionPlan,
    operation: AdapterOperation,
  ) => Promise<ObservationEvidence>;
  readonly collectCorrectnessEvidence: (
    context: ScenarioExecutionPlan,
    operation: AdapterOperation,
  ) => Promise<CorrectnessEvidence>;
  readonly collectFaultEvidence: (
    context: ScenarioExecutionPlan,
    operation: AdapterOperation,
  ) => Promise<FaultEvidence>;
  readonly cleanupResource: (
    resource: CleanupResource,
    context: ScenarioExecutionPlan,
    operation: AdapterOperation,
  ) => Promise<CleanupResourceEvidence>;
}

export interface NetworkLabRunnerOptions {
  readonly signal?: AbortSignal;
  readonly timeouts?: Partial<{
    readonly prepareMs: number;
    readonly actionMs: number;
    readonly controlMs: number;
    readonly evidenceMs: number;
    readonly cleanupResourceMs: number;
  }>;
}

const DEFAULT_TIMEOUTS = {
  prepareMs: 30_000,
  actionMs: 30_000,
  controlMs: 30_000,
  evidenceMs: 30_000,
  cleanupResourceMs: 30_000,
} as const;

class AdapterOperationTimeoutError extends Error {
  override readonly name = "AdapterOperationTimeoutError";
}

function errorEvidence(
  phase: RunnerPhase,
  error: unknown,
  stepId: string | null = null,
  resourceId: string | null = null,
): RunnerErrorEvidence {
  if (error instanceof Error) {
    return {
      phase,
      stepId,
      resourceId,
      name: error.name || "Error",
      message: error.message || "Unknown error",
    };
  }
  return {
    phase,
    stepId,
    resourceId,
    name: "UnknownError",
    message: String(error) || "Unknown error",
  };
}

async function runBounded<T>(
  label: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new AdapterOperationTimeoutError(
        `${label} exceeded its ${String(timeoutMs)} ms deadline.`,
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error(`${label} was aborted.`);
    }
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function assertAdapterProvenance(
  expected: NetworkLabProvenance,
  observed: NetworkLabProvenance,
): void {
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new Error("Adapter provenance does not match the execution plan.");
  }
}

function assertValidLease(lease: ResourceLease): void {
  if (lease.resources.length === 0) {
    throw new Error("Preparation must register at least one cleanup resource.");
  }
  const keys = lease.resources.map((resource) => `${resource.kind}\u0000${resource.id}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Preparation returned duplicate cleanup resources.");
  }
}

function validateCorrectness(evidence: CorrectnessEvidence): CorrectnessEvidence {
  const ids = evidence.assertions.map(({ id }) => id);
  const valid =
    evidence.status === "passed" &&
    ids.length > 0 &&
    ids.every((id) => id.length > 0) &&
    new Set(ids).size === ids.length &&
    evidence.assertions.every(({ passed }) => passed);
  return evidence.status === "passed" && !valid ? { ...evidence, status: "failed" } : evidence;
}

function validateFault(context: ScenarioExecutionPlan, evidence: FaultEvidence): FaultEvidence {
  const planned = context.steps.filter(
    (step): step is PlannedScenarioStep & { step: ScenarioControlStep } =>
      step.step.kind === "control",
  );
  const matches =
    evidence.operations.length === planned.length &&
    evidence.operations.every((operation, index) => {
      const expected = planned[index];
      return (
        expected !== undefined &&
        operation.stepId === expected.step.id &&
        operation.sequence === expected.sequence &&
        operation.decisionToken === expected.decisionToken &&
        canonicalJson(operation.effectiveControl) === canonicalJson(expected.step.control)
      );
    });
  const valid =
    evidence.status === "passed" &&
    evidence.originPathUnshaped &&
    matches &&
    planned.length > 0 &&
    evidence.operations.length > 0;
  return evidence.status === "passed" && !valid ? { ...evidence, status: "failed" } : evidence;
}

async function collectCorrectness(
  adapter: NetworkLabAdapter,
  context: ScenarioExecutionPlan,
  lease: ResourceLease | null,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  errors: Array<RunnerErrorEvidence>,
): Promise<CorrectnessEvidence> {
  try {
    const evidence = await runBounded(
      "correctness evidence collection",
      timeoutMs,
      signal,
      (callSignal) => adapter.collectCorrectnessEvidence(context, { signal: callSignal, lease }),
    );
    return validateCorrectness(evidence);
  } catch (error) {
    errors.push(errorEvidence("correctness-evidence", error));
    return { status: "unavailable", assertions: [] };
  }
}

async function collectFault(
  adapter: NetworkLabAdapter,
  context: ScenarioExecutionPlan,
  lease: ResourceLease | null,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  errors: Array<RunnerErrorEvidence>,
): Promise<FaultEvidence> {
  try {
    const evidence = await runBounded(
      "fault evidence collection",
      timeoutMs,
      signal,
      (callSignal) => adapter.collectFaultEvidence(context, { signal: callSignal, lease }),
    );
    return validateFault(context, evidence);
  } catch (error) {
    errors.push(errorEvidence("fault-evidence", error));
    return { status: "unavailable", originPathUnshaped: false, operations: [] };
  }
}

async function cleanup(
  adapter: NetworkLabAdapter,
  context: ScenarioExecutionPlan,
  lease: ResourceLease | null,
  timeoutMs: number,
  errors: Array<RunnerErrorEvidence>,
): Promise<CleanupEvidence> {
  if (lease === null || lease.resources.length === 0) {
    return { status: "failed", leaseId: lease?.id ?? null, resources: [] };
  }

  const resources: Array<CleanupResourceEvidence> = [];
  for (const resource of lease.resources) {
    try {
      const evidence = await runBounded(
        `cleanup of ${resource.kind}:${resource.id}`,
        timeoutMs,
        undefined,
        (signal) => adapter.cleanupResource(resource, context, { signal, lease }),
      );
      const identityMatches = evidence.kind === resource.kind && evidence.id === resource.id;
      resources.push(
        identityMatches
          ? evidence
          : {
              kind: resource.kind,
              id: resource.id,
              released: false,
              details: evidence.details,
              error: "Cleanup evidence identity did not match the registered resource.",
            },
      );
    } catch (error) {
      errors.push(errorEvidence("cleanup", error, null, resource.id));
      resources.push({
        kind: resource.kind,
        id: resource.id,
        released: false,
        details: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const releasedResources = resources.filter(
    (resource): resource is PassedCleanupResourceEvidence =>
      resource.released && resource.error === null,
  );
  if (releasedResources.length === resources.length) {
    return { status: "passed", leaseId: lease.id, resources: releasedResources };
  }
  return { status: "failed", leaseId: lease.id, resources };
}

async function runStep(
  adapter: NetworkLabAdapter,
  context: ScenarioExecutionPlan,
  lease: ResourceLease,
  plannedStep: PlannedScenarioStep,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ObservationEvidence> {
  const operation = (callSignal: AbortSignal) => ({ signal: callSignal, lease });
  const observation = await runBounded(
    `step ${plannedStep.step.id}`,
    plannedStep.step.kind === "checkpoint" ? plannedStep.step.timeoutMs : timeoutMs,
    signal,
    (callSignal) => {
      if (plannedStep.step.kind === "action") {
        return adapter.executeAction(plannedStep.step, plannedStep, context, operation(callSignal));
      }
      if (plannedStep.step.kind === "control") {
        return adapter.executeControl(
          plannedStep.step,
          plannedStep,
          context,
          operation(callSignal),
        );
      }
      return adapter.waitForCheckpoint(
        plannedStep.step,
        plannedStep,
        context,
        operation(callSignal),
      );
    },
  );
  if (observation.sequence !== plannedStep.sequence) {
    throw new Error(`Step ${plannedStep.step.id} returned evidence for the wrong sequence.`);
  }
  return observation;
}

export async function runNetworkLabScenario(
  context: ScenarioExecutionPlan,
  adapter: NetworkLabAdapter,
  options: NetworkLabRunnerOptions = {},
): Promise<NetworkLabResult> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const errors: Array<RunnerErrorEvidence> = [];
  const steps: Array<StepResult> = [];
  let executionFailed = false;
  let lease: ResourceLease | null = null;
  let correctness: CorrectnessEvidence = { status: "unavailable", assertions: [] };
  let fault: FaultEvidence = { status: "unavailable", originPathUnshaped: false, operations: [] };
  let cleanupEvidence: CleanupEvidence = { status: "failed", leaseId: null, resources: [] };

  try {
    try {
      assertAdapterProvenance(context.provenance, adapter.provenance);
      lease = await runBounded(
        "adapter preparation",
        timeouts.prepareMs,
        options.signal,
        (signal) => adapter.prepare(context, { signal, lease: null }),
      );
      assertValidLease(lease);
    } catch (error) {
      executionFailed = true;
      errors.push(errorEvidence("prepare", error));
    }

    if (!executionFailed && lease !== null) {
      for (const plannedStep of context.steps) {
        try {
          const stepTimeout =
            plannedStep.step.kind === "control" ? timeouts.controlMs : timeouts.actionMs;
          const observation = await runStep(
            adapter,
            context,
            lease,
            plannedStep,
            stepTimeout,
            options.signal,
          );
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

    correctness = await collectCorrectness(
      adapter,
      context,
      lease,
      timeouts.evidenceMs,
      options.signal,
      errors,
    );
    fault = await collectFault(
      adapter,
      context,
      lease,
      timeouts.evidenceMs,
      options.signal,
      errors,
    );
  } finally {
    cleanupEvidence = await cleanup(adapter, context, lease, timeouts.cleanupResourceMs, errors);
  }

  const passed =
    !executionFailed &&
    errors.length === 0 &&
    correctness.status === "passed" &&
    fault.status === "passed" &&
    cleanupEvidence.status === "passed";

  const resultBase = {
    schemaVersion: NETWORK_LAB_RESULT_SCHEMA_VERSION,
    identity: context.identity,
    steps,
  };
  if (
    passed &&
    correctness.status === "passed" &&
    fault.status === "passed" &&
    cleanupEvidence.status === "passed"
  ) {
    return {
      ...resultBase,
      status: "passed",
      evidence: { correctness, fault, cleanup: cleanupEvidence },
      errors: [],
    };
  }
  return {
    ...resultBase,
    status: "failed",
    evidence: { correctness, fault, cleanup: cleanupEvidence },
    errors,
  };
}
