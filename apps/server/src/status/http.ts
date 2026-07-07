import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { getServerIdleStatus } from "./IdleStatus.ts";

export const serverStatusHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "server",
  Effect.fnUntraced(function* (handlers) {
    yield* Effect.void;
    return handlers.handle(
      "idleStatus",
      Effect.fn("environment.server.idleStatus")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* getServerIdleStatus().pipe(
          Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
        );
      }),
    );
  }),
);
