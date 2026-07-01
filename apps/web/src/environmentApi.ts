import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type ClientOrchestrationCommand,
  type CodexThreadForkInput,
  type CodexThreadForkResult,
  type CodexThreadResumeInput,
  type CodexThreadResumeResult,
  type EnvironmentApi,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "./connection/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";

type MinimalEnvironmentApi = {
  readonly codex: Pick<EnvironmentApi["codex"], "forkThread" | "resumeThread">;
  readonly orchestration: Pick<EnvironmentApi["orchestration"], "dispatchCommand">;
};

const dispatchCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-api:orchestration:dispatch-command",
  tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
});

const resumeCodexThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-api:codex:resume-thread",
  tag: WS_METHODS.codexResumeThread,
});

const forkCodexThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-api:codex:fork-thread",
  tag: WS_METHODS.codexForkThread,
});

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

async function unwrapEnvironmentCommand<A>(
  promise: Promise<
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly cause: unknown }
  >,
): Promise<A> {
  const result = await promise;
  if (result._tag === "Success") {
    return result.value;
  }
  throw squashAtomCommandFailure(result as Parameters<typeof squashAtomCommandFailure>[0]);
}

function createMinimalEnvironmentApi(environmentId: EnvironmentId): MinimalEnvironmentApi {
  return {
    codex: {
      forkThread: (input: CodexThreadForkInput): Promise<CodexThreadForkResult> =>
        unwrapEnvironmentCommand(
          runAtomCommand(
            appAtomRegistry,
            forkCodexThread,
            { environmentId, input },
            { reportFailure: false },
          ),
        ),
      resumeThread: (input: CodexThreadResumeInput): Promise<CodexThreadResumeResult> =>
        unwrapEnvironmentCommand(
          runAtomCommand(
            appAtomRegistry,
            resumeCodexThread,
            { environmentId, input },
            { reportFailure: false },
          ),
        ),
    },
    orchestration: {
      dispatchCommand: (command: ClientOrchestrationCommand) =>
        unwrapEnvironmentCommand(
          runAtomCommand(
            appAtomRegistry,
            dispatchCommand,
            { environmentId, input: command },
            { reportFailure: false },
          ),
        ),
    },
  };
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const overriddenApi = environmentApiOverridesForTests.get(environmentId);
  if (overriddenApi) {
    return overriddenApi;
  }

  return createMinimalEnvironmentApi(environmentId) as EnvironmentApi;
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(`Environment API not found for environment ${environmentId}`);
  }
  return api;
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
