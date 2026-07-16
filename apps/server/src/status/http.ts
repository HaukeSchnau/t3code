import {
  AuthDiagnosticsCaptureScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { EnergyCaptureRequests } from "../diagnostics/EnergyCaptureRequests.ts";
import { WorkloadDiagnostics } from "../diagnostics/WorkloadDiagnostics.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { getServerIdleStatus } from "./IdleStatus.ts";

export const serverStatusHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "server",
  Effect.fnUntraced(function* (handlers) {
    const energyCaptureRequests = yield* EnergyCaptureRequests;
    const workloadDiagnostics = yield* WorkloadDiagnostics;
    const providerService = yield* Effect.serviceOption(ProviderService);
    return handlers
      .handle(
        "idleStatus",
        Effect.fn("environment.server.idleStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const liveSessions = Option.isSome(providerService)
            ? yield* providerService.value.listSessions()
            : undefined;
          return yield* getServerIdleStatus(
            liveSessions === undefined ? undefined : { liveSessions },
          ).pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "workloadDiagnostics",
        Effect.fn("environment.server.workloadDiagnostics")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* workloadDiagnostics.read;
        }),
      )
      .handle(
        "requestEnergyCapture",
        Effect.fn("environment.server.requestEnergyCapture")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthDiagnosticsCaptureScope);
          return yield* energyCaptureRequests.requestCapture(args.payload);
        }),
      );
  }),
);
