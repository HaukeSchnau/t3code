import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedErrorClass<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeEnergyDiagnosticsCaptureRequests
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.terminalAttach;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.serverUpdateServerWithProgress
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;

export interface EnvironmentRpcSubscriptionObservation {
  readonly environmentId: string;
  readonly method: EnvironmentSubscriptionRpcTag;
  readonly input: unknown;
}

export class EnvironmentRpcSubscriptionObserver extends Context.Reference<{
  readonly observe: (
    subscription: EnvironmentRpcSubscriptionObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcSubscriptionObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const request = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

export function runStream<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    currentSession().pipe(
      Effect.map((session) => {
        const method = session.client[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : session.client[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              const subscribeToSession = (): Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              > =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      return method(input).pipe(
                        Stream.ensuring(completeObservation),
                        Stream.catchCause((cause) => {
                          const hasOnlyExpectedFailures =
                            cause.reasons.length > 0 &&
                            cause.reasons.every((reason) => reason._tag === "Fail");
                          const isTransportFailure =
                            hasOnlyExpectedFailures &&
                            cause.reasons.every(
                              (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                            );
                          if (isTransportFailure) {
                            return Stream.fromEffect(
                              Effect.logWarning(
                                "Durable RPC subscription lost its transport; waiting for the next session.",
                                {
                                  cause: Cause.pretty(cause),
                                  method: tag,
                                  environmentId: supervisor.target.environmentId,
                                },
                              ),
                            ).pipe(Stream.drain);
                          }
                          if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                            const handled = Stream.fromEffect(
                              options.onExpectedFailure(cause),
                            ).pipe(Stream.drain);
                            if (options.retryExpectedFailureAfter === undefined) {
                              return handled;
                            }
                            return handled.pipe(
                              Stream.concat(
                                Stream.fromEffect(
                                  Effect.sleep(options.retryExpectedFailureAfter),
                                ).pipe(Stream.drain),
                              ),
                              Stream.concat(subscribeToSession()),
                            );
                          }
                          return Stream.failCause(cause);
                        }),
                      );
                    }),
                  ),
                );
              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export interface EnvironmentSubscribeOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
  readonly admission?: {
    readonly group: string;
    readonly maxConcurrent: number;
    readonly releaseWhen: (value: EnvironmentRpcStreamValue<TTag>) => boolean;
  };
}

export type EnvironmentSubscriptionInputFactory<TTag extends EnvironmentSubscriptionRpcTag> = (
  session: RpcSession,
  generation: number,
) => Effect.Effect<EnvironmentRpcInput<TTag>>;

interface NormalizedSubscriptionAdmission<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly group: string;
  readonly maxConcurrent: number;
  readonly releaseWhen: (value: EnvironmentRpcStreamValue<TTag>) => boolean;
}

interface SessionAdmissionGate {
  readonly maxConcurrent: number;
  readonly semaphore: Semaphore.Semaphore;
}

const sessionAdmissionGates = new WeakMap<RpcSession, Map<string, SessionAdmissionGate>>();

function normalizeSubscriptionAdmission<TTag extends EnvironmentSubscriptionRpcTag>(
  admission: EnvironmentSubscribeOptions<TTag>["admission"],
): NormalizedSubscriptionAdmission<TTag> | undefined {
  if (admission === undefined) return undefined;
  if (!Number.isSafeInteger(admission.maxConcurrent) || admission.maxConcurrent <= 0) {
    throw new TypeError(
      `Subscription admission maxConcurrent must be a positive safe integer; received ${admission.maxConcurrent}.`,
    );
  }
  return admission;
}

function sessionAdmissionGate(
  session: RpcSession,
  group: string,
  maxConcurrent: number,
): Effect.Effect<Semaphore.Semaphore> {
  return Effect.sync(() => {
    const gates = sessionAdmissionGates.get(session) ?? new Map<string, SessionAdmissionGate>();
    sessionAdmissionGates.set(session, gates);
    const existing = gates.get(group);
    if (existing !== undefined) {
      if (existing.maxConcurrent !== maxConcurrent) {
        throw new Error(
          `Subscription admission group "${group}" already uses maxConcurrent ${existing.maxConcurrent}; received conflicting ${maxConcurrent}.`,
        );
      }
      return existing.semaphore;
    }
    const semaphore = Semaphore.makeUnsafe(maxConcurrent);
    gates.set(group, { maxConcurrent, semaphore });
    return semaphore;
  });
}

function withSubscriptionAdmission<TTag extends EnvironmentSubscriptionRpcTag>(
  session: RpcSession,
  stream: Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>,
  admission: NormalizedSubscriptionAdmission<TTag> | undefined,
): Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>> {
  if (admission === undefined) return stream;
  return Stream.unwrap(
    Effect.gen(function* () {
      const gate = yield* sessionAdmissionGate(session, admission.group, admission.maxConcurrent);
      const released = yield* Ref.make(false);
      const release = Ref.modify(released, (alreadyReleased) => [alreadyReleased, true]).pipe(
        Effect.flatMap((alreadyReleased) =>
          alreadyReleased ? Effect.void : gate.release(1).pipe(Effect.asVoid),
        ),
      );
      yield* Effect.acquireRelease(gate.take(1), () => release, { interruptible: true });
      return stream.pipe(
        Stream.tap((value) => (admission.releaseWhen(value) ? release : Effect.void)),
      );
    }),
  );
}

function subscribeMapped<TTag extends EnvironmentSubscriptionRpcTag, A>(
  tag: TTag,
  input: EnvironmentSubscriptionInputFactory<TTag>,
  mapValue: (session: RpcSession, generation: number, value: EnvironmentRpcStreamValue<TTag>) => A,
  options?: EnvironmentSubscribeOptions<TTag>,
): Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>, EnvironmentSupervisor> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const admission = normalizeSubscriptionAdmission(options?.admission);
      const supervisor = yield* EnvironmentSupervisor;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : session.client[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              const subscribeToSession = (
                generation: number,
              ): Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>> =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    input(session, generation).pipe(
                      Effect.map((value) =>
                        withSubscriptionAdmission(session, method(value), admission),
                      ),
                    ),
                  ).pipe(
                    Stream.map((value) => mapValue(session, generation, value)),
                    Stream.catchCause((cause) => {
                      const hasOnlyExpectedFailures =
                        cause.reasons.length > 0 &&
                        cause.reasons.every((reason) => reason._tag === "Fail");
                      const isTransportFailure =
                        hasOnlyExpectedFailures &&
                        cause.reasons.every(
                          (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                        );
                      if (isTransportFailure) {
                        return Stream.fromEffect(
                          Effect.logWarning(
                            "Durable RPC subscription lost its transport; waiting for the next session.",
                            {
                              cause: Cause.pretty(cause),
                              method: tag,
                              environmentId: supervisor.target.environmentId,
                            },
                          ),
                        ).pipe(Stream.drain);
                      }
                      if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                        const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                          Stream.drain,
                        );
                        if (options.retryExpectedFailureAfter === undefined) {
                          return handled;
                        }
                        return handled.pipe(
                          Stream.concat(
                            Stream.fromEffect(Effect.sleep(options.retryExpectedFailureAfter)).pipe(
                              Stream.drain,
                            ),
                          ),
                          Stream.concat(subscribeToSession(generation)),
                        );
                      }
                      return Stream.failCause(cause);
                    }),
                  ),
                );
              return Stream.unwrap(
                SubscriptionRef.get(supervisor.state).pipe(
                  Effect.map((state) => subscribeToSession(state.generation)),
                ),
              );
            },
          }),
        ),
      );
    }),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: EnvironmentSubscribeOptions<TTag>,
) {
  return subscribeMapped(
    tag,
    () => Effect.succeed(input),
    (_session, _generation, value) => value,
    options,
  );
}

export interface EnvironmentSubscriptionItem<A> {
  readonly session: RpcSession;
  readonly generation: number;
  readonly value: A;
}

export function subscribeWithSession<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: EnvironmentSubscribeOptions<TTag>,
): Stream.Stream<
  EnvironmentSubscriptionItem<EnvironmentRpcStreamValue<TTag>>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return subscribeMapped(
    tag,
    () => Effect.succeed(input),
    (session, generation, value) => ({ session, generation, value }),
    options,
  );
}

export function subscribeWithSessionDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentSubscriptionInputFactory<TTag>,
  options?: EnvironmentSubscribeOptions<TTag>,
): Stream.Stream<
  EnvironmentSubscriptionItem<EnvironmentRpcStreamValue<TTag>>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return subscribeMapped(
    tag,
    input,
    (session, generation, value) => ({ session, generation, value }),
    options,
  );
}

export const config = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* session.initialConfig;
}).pipe(Effect.withSpan("EnvironmentRpc.config"));
