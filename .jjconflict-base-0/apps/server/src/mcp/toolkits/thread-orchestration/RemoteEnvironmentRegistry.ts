import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  TrimmedNonEmptyString,
  type AuthAccessTokenResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";

export const RemoteOrchestrationEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  lastVerifiedAt: Schema.NullOr(TrimmedNonEmptyString),
});
export type RemoteOrchestrationEnvironment = typeof RemoteOrchestrationEnvironment.Type;

const RemoteOrchestrationEnvironmentFile = Schema.Struct({
  environments: Schema.Array(RemoteOrchestrationEnvironment),
});
const RemoteOrchestrationEnvironmentFileJson = Schema.fromJsonString(
  RemoteOrchestrationEnvironmentFile,
);
const decodeRegistryFile = Schema.decodeEffect(RemoteOrchestrationEnvironmentFileJson);
const encodeRegistryFile = Schema.encodeEffect(RemoteOrchestrationEnvironmentFileJson);

export class RemoteEnvironmentRegistryError extends Schema.TaggedErrorClass<RemoteEnvironmentRegistryError>()(
  "RemoteEnvironmentRegistryError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    environmentId: Schema.optional(EnvironmentId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isRemoteEnvironmentRegistryError = Schema.is(RemoteEnvironmentRegistryError);

export class RemoteEnvironmentRegistry extends Context.Service<
  RemoteEnvironmentRegistry,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<RemoteOrchestrationEnvironment>,
      RemoteEnvironmentRegistryError
    >;
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      Option.Option<RemoteOrchestrationEnvironment>,
      RemoteEnvironmentRegistryError
    >;
    readonly register: (input: {
      readonly descriptor: ExecutionEnvironmentDescriptor;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl?: string;
      readonly bearerToken: string;
    }) => Effect.Effect<RemoteOrchestrationEnvironment, RemoteEnvironmentRegistryError>;
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<boolean, RemoteEnvironmentRegistryError>;
    readonly getBearerToken: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<string>, RemoteEnvironmentRegistryError>;
  }
>()("t3/mcp/toolkits/thread-orchestration/RemoteEnvironmentRegistry") {}

export const accessTokenToBearer = (token: AuthAccessTokenResult): string => token.access_token;

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const secretNameForEnvironment = (environmentId: EnvironmentId): string =>
  `remote-orchestration-${environmentId.replace(/[^a-z0-9._-]/giu, "_")}-bearer`;

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const registryPath = path.join(config.stateDir, "remote-orchestration-environments.json");

  const readFile = () =>
    fs.readFileString(registryPath).pipe(
      Effect.flatMap((raw) =>
        decodeRegistryFile(raw).pipe(
          Effect.mapError(
            (cause) =>
              new RemoteEnvironmentRegistryError({
                operation: "read",
                message: "Failed to decode remote orchestration registry.",
                cause,
              }),
          ),
        ),
      ),
      Effect.catch((cause) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "reason" in cause &&
          typeof cause.reason === "object" &&
          cause.reason !== null &&
          "_tag" in cause.reason &&
          cause.reason._tag === "NotFound"
        ) {
          return Effect.succeed({ environments: [] });
        }
        if (isRemoteEnvironmentRegistryError(cause)) {
          return Effect.fail(cause);
        }
        return Effect.fail(
          new RemoteEnvironmentRegistryError({
            operation: "read",
            message: "Failed to read remote orchestration registry.",
            cause,
          }),
        );
      }),
    );

  const writeFile = (file: typeof RemoteOrchestrationEnvironmentFile.Type) =>
    fs.makeDirectory(path.dirname(registryPath), { recursive: true }).pipe(
      Effect.flatMap(() => encodeRegistryFile(file)),
      Effect.flatMap((contents) => fs.writeFileString(registryPath, `${contents}\n`)),
      Effect.mapError(
        (cause) =>
          new RemoteEnvironmentRegistryError({
            operation: "write",
            message: "Failed to persist remote orchestration registry.",
            cause,
          }),
      ),
    );

  const list = () => readFile().pipe(Effect.map((file) => file.environments));

  const get: RemoteEnvironmentRegistry["Service"]["get"] = (environmentId) =>
    list().pipe(
      Effect.map((environments) =>
        Option.fromUndefinedOr(
          environments.find((environment) => environment.environmentId === environmentId),
        ),
      ),
    );

  const register: RemoteEnvironmentRegistry["Service"]["register"] = (input) =>
    Effect.gen(function* () {
      const file = yield* readFile();
      const timestamp = yield* nowIso;
      const httpBaseUrl = normalizeBaseUrl(input.httpBaseUrl);
      const wsBaseUrl = input.wsBaseUrl === undefined ? null : normalizeBaseUrl(input.wsBaseUrl);
      const existing = file.environments.find(
        (environment) => environment.environmentId === input.descriptor.environmentId,
      );
      const next: RemoteOrchestrationEnvironment = {
        environmentId: input.descriptor.environmentId,
        label: input.descriptor.label,
        httpBaseUrl,
        wsBaseUrl,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastVerifiedAt: timestamp,
      };
      const environments = [
        next,
        ...file.environments.filter(
          (environment) => environment.environmentId !== input.descriptor.environmentId,
        ),
      ];
      yield* writeFile({ environments });
      yield* secretStore
        .set(
          secretNameForEnvironment(input.descriptor.environmentId),
          new TextEncoder().encode(input.bearerToken),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new RemoteEnvironmentRegistryError({
                operation: "register.secret",
                message: "Failed to persist remote orchestration bearer token.",
                environmentId: input.descriptor.environmentId,
                cause,
              }),
          ),
        );
      return next;
    });

  const remove: RemoteEnvironmentRegistry["Service"]["remove"] = (environmentId) =>
    Effect.gen(function* () {
      const file = yield* readFile();
      const environments = file.environments.filter(
        (environment) => environment.environmentId !== environmentId,
      );
      if (environments.length === file.environments.length) {
        return false;
      }
      yield* writeFile({ environments });
      yield* secretStore.remove(secretNameForEnvironment(environmentId)).pipe(Effect.ignore);
      return true;
    });

  const getBearerToken: RemoteEnvironmentRegistry["Service"]["getBearerToken"] = (environmentId) =>
    secretStore.get(secretNameForEnvironment(environmentId)).pipe(
      Effect.map((value) =>
        Option.map(value, (bytes) => new TextDecoder().decode(bytes).trim()).pipe(
          Option.filter((token) => token.length > 0),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new RemoteEnvironmentRegistryError({
            operation: "token.read",
            message: "Failed to read remote orchestration bearer token.",
            environmentId,
            cause,
          }),
      ),
    );

  return RemoteEnvironmentRegistry.of({ list, get, register, remove, getBearerToken });
});

export const layer = Layer.effect(RemoteEnvironmentRegistry, make);
