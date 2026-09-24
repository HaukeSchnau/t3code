import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { WorkloadDiagnostics } from "../diagnostics/WorkloadDiagnostics.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CommandPreprocessingCoordinator } from "../orchestration/Services/CommandPreprocessingCoordinator.ts";
import { getServerIdleStatus } from "./IdleStatus.ts";

export const serverStatusHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "server",
  Effect.fnUntraced(function* (handlers) {
    const workloadDiagnostics = yield* WorkloadDiagnostics;
    const providerService = yield* Effect.serviceOption(ProviderService);
    const commandPreprocessing = yield* CommandPreprocessingCoordinator;
    return handlers
      .handle(
        "idleStatus",
        Effect.fn("environment.server.idleStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const liveSessions = Option.isSome(providerService)
            ? yield* providerService.value.listSessions()
            : undefined;
          return yield* getServerIdleStatus({
            ...(liveSessions === undefined ? {} : { liveSessions }),
            activeCommandThreadIds: yield* commandPreprocessing.activeThreadIds,
          }).pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "workloadDiagnostics",
        Effect.fn("environment.server.workloadDiagnostics")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* workloadDiagnostics.read;
        }),
      );
  }),
);
