import {
  type EnvironmentHttpApiClient,
  makeEnvironmentHttpApiClient,
} from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolvePrimaryEnvironmentHttpUrl } from "./target";

export type PrimaryEnvironmentHttpClient =
  "@t3tools/web/environments/primary/httpClient/PrimaryEnvironmentHttpClient";

export const PrimaryEnvironmentHttpClient: Context.Service<
  PrimaryEnvironmentHttpClient,
  EnvironmentHttpApiClient
> = Context.Service<PrimaryEnvironmentHttpClient, EnvironmentHttpApiClient>(
  "@t3tools/web/environments/primary/httpClient/PrimaryEnvironmentHttpClient",
);

const make = Effect.suspend(() =>
  makeEnvironmentHttpApiClient(resolvePrimaryEnvironmentHttpUrl("/")),
);

export const layer = Layer.effect(PrimaryEnvironmentHttpClient, make);
