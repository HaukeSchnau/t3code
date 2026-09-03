import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const LIVE_ACTIVITY_NAME = "AgentActivity";
const PROVIDER_TOKEN_TTL_MS = 45 * 60 * 1_000;
const STALE_AFTER_SECONDS = 10 * 60;
const DISMISS_AFTER_SECONDS = 5 * 60;
const CONTENTLESS_DISMISS_AFTER_SECONDS = 15;

export interface ApnsProviderCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
}

interface ApnsTarget {
  readonly token: string;
  readonly bundleId: string;
  readonly environment: "sandbox" | "production";
}

export interface ApnsAlert {
  readonly title: string;
  readonly body: string;
}

export interface ApnsDeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason: string | null;
  readonly apnsId: string | null;
}

export class ApnsProviderConfigurationError extends Schema.TaggedErrorClass<ApnsProviderConfigurationError>()(
  "ApnsProviderConfigurationError",
  { message: Schema.String },
) {}

export class ApnsProviderDeliveryError extends Schema.TaggedErrorClass<ApnsProviderDeliveryError>()(
  "ApnsProviderDeliveryError",
  {
    message: Schema.String,
    tokenSuffix: Schema.String,
    cause: Schema.Defect(),
  },
) {}

function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function makeApnsProviderToken(input: {
  readonly credentials: ApnsProviderCredentials;
  readonly issuedAtUnixSeconds: number;
}): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "ES256", kid: input.credentials.keyId }));
  const payload = encodeBase64Url(
    JSON.stringify({ iss: input.credentials.teamId, iat: input.issuedAtUnixSeconds }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: input.credentials.privateKey.replace(/\\n/g, "\n"),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

function contentState(state: RelayAgentActivityAggregateState) {
  return {
    name: LIVE_ACTIVITY_NAME,
    props: JSON.stringify(state),
  };
}

export function makeLiveActivityPayload(input: {
  readonly event: "update" | "end";
  readonly state: RelayAgentActivityAggregateState | null;
  readonly alert?: ApnsAlert | null;
  readonly nowEpochSeconds: number;
}) {
  const alert = input.alert
    ? {
        alert: {
          title: input.alert.title,
          body: input.alert.body,
          sound: "default",
        },
      }
    : {};
  if (input.event === "end") {
    return {
      aps: {
        timestamp: input.nowEpochSeconds,
        event: "end",
        ...(input.state ? { "content-state": contentState(input.state) } : {}),
        ...alert,
        "dismissal-date":
          input.nowEpochSeconds +
          (input.state ? DISMISS_AFTER_SECONDS : CONTENTLESS_DISMISS_AFTER_SECONDS),
      },
    };
  }
  if (!input.state) {
    throw new Error("A Live Activity update requires content state.");
  }
  return {
    aps: {
      timestamp: input.nowEpochSeconds,
      event: "update",
      ...alert,
      "content-state": contentState(input.state),
      "stale-date": input.nowEpochSeconds + STALE_AFTER_SECONDS,
    },
  };
}

export function makeNotificationPayload(input: {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
}) {
  return {
    aps: {
      alert: { title: input.title, body: input.body },
      sound: "default",
    },
    environmentId: input.environmentId,
    threadId: input.threadId,
    deepLink: input.deepLink,
  };
}

function apnsOrigin(environment: ApnsTarget["environment"]): string {
  return environment === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

function responseHeader(headers: NodeHttp2.IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function parseApnsReason(body: string): string | null {
  if (!body.trim()) return null;
  return Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ reason: Schema.optional(Schema.String) })),
  )(body).pipe(
    Option.map((decoded) => decoded.reason ?? body),
    Option.getOrElse(() => body),
  );
}

function sendHttp2Request(input: {
  readonly target: ApnsTarget;
  readonly providerToken: string;
  readonly pushType: "alert" | "liveactivity";
  readonly priority: "5" | "10";
  readonly payload: unknown;
}): Promise<ApnsDeliveryResult> {
  return new Promise((resolve, reject) => {
    const client = NodeHttp2.connect(apnsOrigin(input.target.environment));
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      client.close();
      action();
    };
    client.once("error", (cause) => finish(() => reject(cause)));
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${input.target.token}`,
      authorization: `bearer ${input.providerToken}`,
      "apns-priority": input.priority,
      "apns-push-type": input.pushType,
      "apns-topic":
        input.pushType === "liveactivity"
          ? `${input.target.bundleId}.push-type.liveactivity`
          : input.target.bundleId,
      "content-type": "application/json",
    });
    let responseHeaders: NodeHttp2.IncomingHttpHeaders = {};
    let responseBody = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      responseHeaders = headers;
    });
    request.on("data", (chunk: string) => {
      responseBody += chunk;
    });
    request.once("error", (cause) => finish(() => reject(cause)));
    request.on("end", () => {
      const status = Number(responseHeaders[":status"] ?? 0);
      finish(() =>
        resolve({
          ok: status >= 200 && status < 300,
          status,
          reason: parseApnsReason(responseBody),
          apnsId: responseHeader(responseHeaders, "apns-id"),
        }),
      );
    });
    request.end(JSON.stringify(input.payload));
  });
}

function configuredCredentialSource(
  env: NodeJS.ProcessEnv,
):
  | { readonly kind: "inline"; readonly value: string }
  | { readonly kind: "file"; readonly value: string }
  | null {
  const inline = env.T3CODE_APNS_PRIVATE_KEY?.trim();
  const file = env.T3CODE_APNS_PRIVATE_KEY_FILE?.trim();
  if (inline && file) {
    throw new ApnsProviderConfigurationError({
      message: "Set only one of T3CODE_APNS_PRIVATE_KEY or T3CODE_APNS_PRIVATE_KEY_FILE.",
    });
  }
  if (inline) return { kind: "inline", value: inline };
  if (file) return { kind: "file", value: file };
  return null;
}

export function resolveApnsProviderConfiguration(env: NodeJS.ProcessEnv): {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKeySource:
    | { readonly kind: "inline"; readonly value: string }
    | { readonly kind: "file"; readonly value: string };
} | null {
  const teamId = env.T3CODE_APNS_TEAM_ID?.trim();
  const keyId = env.T3CODE_APNS_KEY_ID?.trim();
  const privateKeySource = configuredCredentialSource(env);
  if (!teamId && !keyId && !privateKeySource) return null;
  if (!teamId || !keyId || !privateKeySource) {
    throw new ApnsProviderConfigurationError({
      message:
        "T3CODE_APNS_TEAM_ID, T3CODE_APNS_KEY_ID, and an APNs private key must be configured together.",
    });
  }
  return { teamId, keyId, privateKeySource };
}

export class ApnsProvider extends Context.Service<
  ApnsProvider,
  {
    readonly configured: boolean;
    readonly sendLiveActivity: (input: {
      readonly target: ApnsTarget;
      readonly event: "update" | "end";
      readonly state: RelayAgentActivityAggregateState | null;
      readonly alert?: ApnsAlert | null;
    }) => Effect.Effect<ApnsDeliveryResult, ApnsProviderDeliveryError>;
    readonly sendNotification: (input: {
      readonly target: ApnsTarget;
      readonly title: string;
      readonly body: string;
      readonly environmentId: string;
      readonly threadId: string;
      readonly deepLink: string;
    }) => Effect.Effect<ApnsDeliveryResult, ApnsProviderDeliveryError>;
  }
>()("t3/agentAwareness/ApnsProvider") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const configured = yield* Effect.try({
    try: () => resolveApnsProviderConfiguration(process.env),
    catch: (cause) =>
      Schema.is(ApnsProviderConfigurationError)(cause)
        ? cause
        : new ApnsProviderConfigurationError({ message: String(cause) }),
  });
  const credentials = configured
    ? {
        teamId: configured.teamId,
        keyId: configured.keyId,
        privateKey:
          configured.privateKeySource.kind === "inline"
            ? configured.privateKeySource.value
            : yield* fileSystem.readFileString(configured.privateKeySource.value).pipe(
                Effect.mapError(
                  (cause) =>
                    new ApnsProviderConfigurationError({
                      message: `Could not load the APNs private key: ${String(cause)}`,
                    }),
                ),
              ),
      }
    : null;
  let cachedProviderToken: { readonly token: string; readonly createdAtMs: number } | null = null;

  const providerToken = (now: number) => {
    if (!credentials) throw new Error("APNs provider credentials are not configured.");
    if (cachedProviderToken && now - cachedProviderToken.createdAtMs < PROVIDER_TOKEN_TTL_MS) {
      return cachedProviderToken.token;
    }
    const token = makeApnsProviderToken({
      credentials,
      issuedAtUnixSeconds: Math.floor(now / 1_000),
    });
    cachedProviderToken = { token, createdAtMs: now };
    return token;
  };

  const send = Effect.fn("ApnsProvider.send")(function* (input: {
    readonly target: ApnsTarget;
    readonly pushType: "alert" | "liveactivity";
    readonly priority: "5" | "10";
    readonly payload: unknown;
  }) {
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.tryPromise({
      try: () =>
        sendHttp2Request({
          ...input,
          providerToken: providerToken(now),
        }),
      catch: (cause) =>
        new ApnsProviderDeliveryError({
          message: "APNs delivery failed before a response was received.",
          tokenSuffix: input.target.token.slice(-8),
          cause,
        }),
    });
  });

  return ApnsProvider.of({
    configured: credentials !== null,
    sendLiveActivity: Effect.fn("ApnsProvider.sendLiveActivity")(function* (input) {
      const nowEpochSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
      return yield* send({
        target: input.target,
        pushType: "liveactivity",
        priority: input.event === "update" && !input.alert ? "5" : "10",
        payload: makeLiveActivityPayload({
          event: input.event,
          state: input.state,
          alert: input.alert ?? null,
          nowEpochSeconds,
        }),
      });
    }),
    sendNotification: Effect.fn("ApnsProvider.sendNotification")(function* (input) {
      return yield* send({
        target: input.target,
        pushType: "alert",
        priority: "10",
        payload: makeNotificationPayload(input),
      });
    }),
  });
});

export const layer = Layer.effect(ApnsProvider, make);
