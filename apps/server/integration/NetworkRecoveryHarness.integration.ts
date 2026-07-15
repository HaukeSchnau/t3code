// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture owns real Node HTTP/WebSocket and hashing boundaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  ProjectId,
  ThreadId,
  WsOrchestrationDispatchCommandRpc,
  defaultInstanceIdForDriver,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/unstable/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Socket from "effect/unstable/socket/Socket";

import type {
  NetworkLabProvenance,
  ResourceLease,
  ScenarioExecutionPlan,
} from "../../../scripts/network-lab/model.ts";
import type {
  CleanupResourceEvidence,
  CorrectnessAssertion,
  CorrectnessEvidence,
  FaultEvidence,
  FaultOperationEvidence,
  ObservationEvidence,
} from "../../../scripts/network-lab/result.ts";
import type { NetworkLabAdapter } from "../../../scripts/network-lab/runner.ts";
import { canonicalJson } from "../../../scripts/network-lab/scenario.ts";
import type { OrchestrationCommandReceipt } from "../src/persistence/Services/OrchestrationCommandReceipts.ts";
import type { TurnProcessingQuiescedReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import { codexTurnTextFixture } from "./fixtures/providerRuntime.ts";

const RecoveryRpcGroup = RpcGroup.make(WsOrchestrationDispatchCommandRpc);
const makeRecoveryRpcClient = RpcClient.make(RecoveryRpcGroup);

export const NETWORK_RECOVERY_PROVENANCE = {
  lab: { id: "network-lab", version: 1 },
  adapter: { id: "direct-effect-rpc-server-provider", version: 1 },
} as const satisfies NetworkLabProvenance;

const PROJECT_ID = ProjectId.make("nl1-project");
const THREAD_ID = ThreadId.make("nl1-thread");
const COMMAND_ID = CommandId.make("nl1-turn-start");
const MESSAGE_ID = MessageId.make("nl1-user-message");
const CREATED_AT = "2026-07-15T12:00:00.000Z";
const PROTOCOL = "effect-rpc-json-v1/orchestration.dispatchCommand";

export const NETWORK_RECOVERY_PROTOCOL = PROTOCOL;

const frozenCommand = Object.freeze({
  type: "thread.turn.start" as const,
  commandId: COMMAND_ID,
  threadId: THREAD_ID,
  message: Object.freeze({
    messageId: MESSAGE_ID,
    role: "user" as const,
    text: "NL1 deterministic recovery",
    attachments: Object.freeze([]),
  }),
  runtimeMode: "approval-required" as const,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: CREATED_AT,
}) satisfies ClientOrchestrationCommand;

interface CapturedRequest {
  readonly session: number;
  readonly requestId: string;
  readonly commandId: string;
  readonly envelope: ClientOrchestrationCommand;
  readonly envelopeHash: string;
}

interface SuppressedExit {
  readonly requestId: string;
  readonly sequence: number;
  readonly receipt: OrchestrationCommandReceipt;
}

export interface NetworkRecoverySummary {
  readonly semanticProjection: unknown;
  readonly semanticHash: string;
  readonly commandEventTypes: ReadonlyArray<string>;
  readonly providerSendCount: number;
  readonly providerTurnCount: number;
  readonly capturedRequests: ReadonlyArray<CapturedRequest>;
  readonly suppressedExit: SuppressedExit | null;
  readonly normalizedControlTranscript: string;
}

interface OriginRuntime {
  readonly url: string;
  readonly port: number;
  readonly dispose: () => Promise<void>;
}

interface FixtureState {
  orchestrationScope: Scope.Closeable | null;
  harness: OrchestrationIntegrationHarness | null;
  origin: OriginRuntime | null;
  lease: ResourceLease | null;
  activeClientSessions: number;
  clientSessionsOpened: number;
  clientLinkReleased: boolean;
  originReleased: boolean;
  orchestrationReleased: boolean;
  temporaryDirectoryReleased: boolean;
  controlOperations: Array<FaultOperationEvidence>;
  capturedRequests: Array<CapturedRequest>;
  suppressedExit: SuppressedExit | null;
  suppressionArmed: boolean;
  suppressionTargetCount: number;
  suppressedCount: number;
  droppedNonTargetFrames: number;
  clientLinkClosedAfterSuppression: boolean;
  commitProofFailure: string | null;
  firstDispatchWasAmbiguous: boolean;
  firstDispatchSequence: number | null;
  retrySequence: number | null;
  finalThread: OrchestrationThread | null;
  finalReceipt: OrchestrationCommandReceipt | null;
  commandEvents: Array<OrchestrationEvent>;
  providerTurnCount: number;
  semanticProjection: unknown;
  semanticHash: string;
  summary: NetworkRecoverySummary | null;
}

export interface NetworkRecoveryAdapter extends NetworkLabAdapter {
  readonly readSummary: () => NetworkRecoverySummary | null;
  readonly retryCleanup: () => Promise<ReadonlyArray<CleanupResourceEvidence>>;
}

export interface MakeNetworkRecoveryAdapterOptions {
  readonly receiptProof?: "available" | "unavailable";
}

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function frameText(frame: string | Uint8Array): string {
  return typeof frame === "string" ? frame : new TextDecoder().decode(frame);
}

function parseFrame(frame: string | Uint8Array): unknown {
  try {
    return JSON.parse(frameText(frame));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function semanticProjection(thread: OrchestrationThread): unknown {
  return {
    thread: {
      id: thread.id,
      projectId: thread.projectId,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      latestTurn: thread.latestTurn
        ? {
            state: thread.latestTurn.state,
            hasAssistantMessage: thread.latestTurn.assistantMessageId !== null,
          }
        : null,
      session: thread.session
        ? {
            status: thread.session.status,
            providerName: thread.session.providerName,
            providerInstanceId: thread.session.providerInstanceId ?? null,
            runtimeMode: thread.session.runtimeMode,
            activeTurn: thread.session.activeTurnId !== null,
            lastError: thread.session.lastError,
          }
        : null,
      messages: thread.messages.map((message) => ({
        id: message.role === "user" ? message.id : null,
        role: message.role,
        text: message.text,
        attachments: message.attachments ?? [],
        hasTurn: message.turnId !== null,
        streaming: message.streaming,
      })),
      checkpoints: thread.checkpoints.map((checkpoint) => ({
        checkpointTurnCount: checkpoint.checkpointTurnCount,
        status: checkpoint.status,
        files: checkpoint.files,
        hasAssistantMessage: checkpoint.assistantMessageId !== null,
      })),
      activityKinds: thread.activities.map((activity) => activity.kind),
    },
  };
}

function makeOriginRuntime(
  harness: OrchestrationIntegrationHarness,
  state: FixtureState,
): Effect.Effect<OriginRuntime> {
  return Effect.gen(function* () {
    const handlers = RecoveryRpcGroup.toLayer(
      RecoveryRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          harness.engine.dispatch(normalizeAttachmentFreeCommand(command)).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch NL1 orchestration command",
                  cause,
                }),
            ),
          ),
      }),
    );
    const protocol = RpcServer.layerProtocolWebsocket({ path: "/rpc" }).pipe(
      Layer.provide(HttpRouter.layer),
    );
    const rawServer = NodeHttp.createServer();
    const rpcServer = RpcServer.layer(RecoveryRpcGroup).pipe(Layer.provide(handlers));
    const application = rpcServer.pipe(
      Layer.provideMerge(protocol),
      Layer.provide(
        HttpRouter.serve(protocol, {
          disableListenLog: true,
          disableLogger: true,
        }),
      ),
      Layer.provide([
        NodeHttpServer.layer(() => rawServer, { host: "127.0.0.1", port: 0 }),
        RpcSerialization.layerJson,
      ]),
    );
    const serverFiber = yield* Layer.launch(application).pipe(Effect.forkDetach);
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          if (rawServer.listening) {
            resolve();
            return;
          }
          rawServer.once("listening", resolve);
          rawServer.once("error", reject);
        }),
    );
    const address = rawServer.address();
    if (address === null || typeof address === "string") {
      yield* Fiber.interrupt(serverFiber);
      return yield* Effect.die(new Error("NL1 origin server did not bind a TCP address."));
    }
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    return {
      url: `ws://127.0.0.1:${String(address.port)}/rpc`,
      port: address.port,
      dispose: () => runPromise(Fiber.interrupt(serverFiber)),
    };
  });
}

function normalizeAttachmentFreeCommand(
  command: ClientOrchestrationCommand,
): OrchestrationCommand {
  if (command.type !== "thread.turn.start" || command.message.attachments.length !== 0) {
    throw new Error("NL1 accepts only an attachment-free thread.turn.start envelope.");
  }
  return {
    ...command,
    message: {
      ...command.message,
      attachments: [],
    },
  } as OrchestrationCommand;
}

function seedProjectAndThread(harness: OrchestrationIntegrationHarness) {
  const provider = harness.adapterHarness?.provider;
  if (!provider) {
    return Effect.die(new Error("NL1 requires the deterministic provider adapter."));
  }
  const model = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  const modelSelection = {
    instanceId: defaultInstanceIdForDriver(provider),
    model,
  };
  return Effect.gen(function* () {
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("nl1-project-create"),
      projectId: PROJECT_ID,
      title: "NL1 Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: modelSelection,
      createdAt: CREATED_AT,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("nl1-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "NL1 Thread",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt: CREATED_AT,
    });
    yield* harness.adapterHarness!.queueTurnResponseForNextSession({
      events: codexTurnTextFixture,
    });
  });
}

function makeDecoratedSocket(input: {
  readonly base: Socket.Socket;
  readonly session: number;
  readonly state: FixtureState;
  readonly harness: OrchestrationIntegrationHarness;
  readonly receiptProof: "available" | "unavailable";
}): Socket.Socket {
  const onClientFrame = (frame: string | Uint8Array) =>
    Effect.sync(() => {
      const decoded = parseFrame(frame);
      if (
        !isRecord(decoded) ||
        decoded._tag !== "Request" ||
        decoded.tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
        typeof decoded.id !== "string" ||
        !isRecord(decoded.payload)
      ) {
        return;
      }
      const envelope = decoded.payload as ClientOrchestrationCommand;
      input.state.capturedRequests.push({
        session: input.session,
        requestId: decoded.id,
        commandId: String(envelope.commandId),
        envelope,
        envelopeHash: sha256(canonicalJson(decoded.payload as never)),
      });
    }).pipe(Effect.orDie);

  const inspectOriginFrame = (frame: string | Uint8Array) =>
    Effect.gen(function* () {
      const decoded = parseFrame(frame);
      if (
        !input.state.suppressionArmed ||
        input.state.suppressedCount >= input.state.suppressionTargetCount ||
        !isRecord(decoded) ||
        decoded._tag !== "Exit" ||
        typeof decoded.requestId !== "string" ||
        !isRecord(decoded.exit) ||
        decoded.exit._tag !== "Success" ||
        !isRecord(decoded.exit.value) ||
        typeof decoded.exit.value.sequence !== "number"
      ) {
        return false;
      }
      const request = input.state.capturedRequests.find(
        (candidate) =>
          candidate.session === input.session && candidate.requestId === decoded.requestId,
      );
      if (!request || request.commandId !== COMMAND_ID) {
        input.state.droppedNonTargetFrames += 1;
        return false;
      }
      if (input.receiptProof === "unavailable") {
        input.state.commitProofFailure = "Injected unavailable receipt proof.";
        return false;
      }
      const receipt = yield* input.harness.getCommandReceipt(COMMAND_ID);
      if (Option.isNone(receipt)) {
        input.state.commitProofFailure = "Accepted receipt was not observable before Exit delivery.";
        return false;
      }
      const value = receipt.value;
      const sequence = decoded.exit.value.sequence;
      if (
        value.status !== "accepted" ||
        value.commandVariant !== "thread.turn.start" ||
        value.envelopeFingerprint === null ||
        value.resultSequence !== sequence ||
        sequence <= 0
      ) {
        input.state.commitProofFailure = "Receipt identity or result sequence did not match Exit.";
        return false;
      }
      input.state.suppressedCount += 1;
      input.state.suppressionArmed = false;
      input.state.suppressedExit = {
        requestId: decoded.requestId,
        sequence,
        receipt: value,
      };
      return true;
    });

  const runRaw: Socket.Socket["runRaw"] = <_, E, R>(
    handler: (frame: string | Uint8Array) => Effect.Effect<_, E, R> | void,
    options?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    Effect.scopedWith((scope) =>
      Scope.provide(input.base.writer, scope).pipe(
        Effect.flatMap((write) =>
          input.base.runRaw((frame) =>
            inspectOriginFrame(frame).pipe(
              Effect.flatMap((suppress): Effect.Effect<void, Socket.SocketError | E, R> => {
                if (!suppress) {
                  const handled = handler(frame);
                  return Effect.isEffect(handled) ? Effect.asVoid(handled) : Effect.void;
                }
                input.state.clientLinkClosedAfterSuppression = true;
                return write(new Socket.CloseEvent(1012, "nl1-correlated-exit-suppressed"));
              }),
            ),
          options),
        ),
      ),
    );

  return Socket.make({
    writer: input.base.writer.pipe(
      Effect.map((write) => (frame) =>
        Socket.isCloseEvent(frame)
          ? write(frame)
          : onClientFrame(frame).pipe(Effect.andThen(write(frame))),
      ),
    ),
    runRaw,
  });
}

function dispatchOnNewSession(input: {
  readonly state: FixtureState;
  readonly harness: OrchestrationIntegrationHarness;
  readonly origin: OriginRuntime;
  readonly receiptProof: "available" | "unavailable";
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      input.state.activeClientSessions += 1;
      input.state.clientSessionsOpened += 1;
      const session = input.state.clientSessionsOpened;
      const base = yield* Socket.makeWebSocket(input.origin.url, { openTimeout: 2_000 }).pipe(
        Effect.provide(NodeSocket.layerWebSocketConstructorWS),
      );
      const decorated = makeDecoratedSocket({
        base,
        session,
        state: input.state,
        harness: input.harness,
        receiptProof: input.receiptProof,
      });
      const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
        Layer.provide(Layer.succeed(Socket.Socket, decorated)),
        Layer.provide(RpcSerialization.layerJson),
      );
      return yield* makeRecoveryRpcClient.pipe(
        Effect.flatMap((client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand](frozenCommand),
        ),
        Effect.provide(protocol),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          input.state.activeClientSessions -= 1;
        }),
      ),
    ),
  );
}

function emptyState(): FixtureState {
  return {
    orchestrationScope: null,
    harness: null,
    origin: null,
    lease: null,
    activeClientSessions: 0,
    clientSessionsOpened: 0,
    clientLinkReleased: false,
    originReleased: false,
    orchestrationReleased: false,
    temporaryDirectoryReleased: false,
    controlOperations: [],
    capturedRequests: [],
    suppressedExit: null,
    suppressionArmed: false,
    suppressionTargetCount: 0,
    suppressedCount: 0,
    droppedNonTargetFrames: 0,
    clientLinkClosedAfterSuppression: false,
    commitProofFailure: null,
    firstDispatchWasAmbiguous: false,
    firstDispatchSequence: null,
    retrySequence: null,
    finalThread: null,
    finalReceipt: null,
    commandEvents: [],
    providerTurnCount: 0,
    semanticProjection: null,
    semanticHash: "",
    summary: null,
  };
}

function requirePrepared(state: FixtureState) {
  if (!state.harness || !state.origin || !state.lease) {
    throw new Error("NL1 adapter has not been prepared.");
  }
  return {
    harness: state.harness,
    origin: state.origin,
    lease: state.lease,
  };
}

function observation(key: string, sequence: number, details: Record<string, unknown> = {}) {
  return {
    key,
    sequence,
    details,
  } as ObservationEvidence;
}

export function makeNetworkRecoveryAdapter(
  options: MakeNetworkRecoveryAdapterOptions = {},
): NetworkRecoveryAdapter {
  const receiptProof = options.receiptProof ?? "available";
  const state = emptyState();

  const prepare: NetworkLabAdapter["prepare"] = async (context, operation) => {
    const scope = await Effect.runPromise(Scope.make("sequential"), { signal: operation.signal });
    state.orchestrationScope = scope;
    const harness = await Effect.runPromise(
      makeOrchestrationIntegrationHarness().pipe(
        Scope.provide(scope),
        Effect.provide(NodeServices.layer),
      ),
      { signal: operation.signal },
    );
    state.harness = harness;
    await Effect.runPromise(seedProjectAndThread(harness), { signal: operation.signal });
    const origin = await Effect.runPromise(makeOriginRuntime(harness, state), {
      signal: operation.signal,
    });
    state.origin = origin;
    state.lease = {
      id: `nl1-${context.identity.executionId}`,
      resources: [
        { kind: "client-link", id: `client-link:${String(origin.port)}` },
        { kind: "origin-server", id: `origin-server:${String(origin.port)}` },
        { kind: "orchestration-runtime", id: `orchestration:${context.identity.executionId}` },
        { kind: "temporary-directory", id: harness.rootDir },
      ],
    };
    return state.lease;
  };

  const executeControl: NetworkLabAdapter["executeControl"] = async (
    step,
    plannedStep,
    _context,
    operation,
  ) => {
    if (
      step.control.kind !== "protocol-suppression" ||
      step.control.protocol !== PROTOCOL ||
      step.control.direction !== "origin-to-client" ||
      step.control.message !== "response"
    ) {
      throw new Error("NL1 supports only the correlated Effect RPC response suppression control.");
    }
    operation.signal.throwIfAborted();
    state.suppressionArmed = step.control.lifecycle === "apply";
    state.suppressionTargetCount =
      step.control.lifecycle === "apply" ? step.control.count : 0;
    state.controlOperations.push({
      stepId: step.id,
      sequence: plannedStep.sequence,
      decisionToken: plannedStep.decisionToken,
      effectiveControl: step.control,
      details: {
        originPath: "unshaped",
        providerTransport: "in-process",
        clientSurface: "decorated-effect-socket",
      },
    });
    return observation(step.control.kind, plannedStep.sequence, {
      lifecycle: step.control.lifecycle,
    });
  };

  const executeAction: NetworkLabAdapter["executeAction"] = async (
    step,
    plannedStep,
    _context,
    operation,
  ) => {
    const { harness, origin } = requirePrepared(state);
    if (step.action === "client.command.dispatch") {
      const exit = await Effect.runPromiseExit(
        dispatchOnNewSession({ state, harness, origin, receiptProof }),
        { signal: operation.signal },
      );
      if (Exit.isSuccess(exit)) {
        state.firstDispatchSequence = exit.value.sequence;
      } else {
        state.firstDispatchWasAmbiguous =
          state.suppressedExit !== null && state.clientLinkClosedAfterSuppression;
      }
      return observation(step.action, plannedStep.sequence, {
        outcome: Exit.isSuccess(exit) ? "accepted" : "ambiguous-transport-failure",
        session: state.clientSessionsOpened,
      });
    }
    if (step.action === "client.command.retry") {
      const result = await Effect.runPromise(
        dispatchOnNewSession({ state, harness, origin, receiptProof }),
        { signal: operation.signal },
      );
      state.retrySequence = result.sequence;
      return observation(step.action, plannedStep.sequence, {
        outcome: "accepted",
        sequence: result.sequence,
        session: state.clientSessionsOpened,
      });
    }
    throw new Error(`Unsupported NL1 action '${step.action}'.`);
  };

  const waitForCheckpoint: NetworkLabAdapter["waitForCheckpoint"] = async (
    step,
    plannedStep,
    _context,
    operation,
  ) => {
    const { harness } = requirePrepared(state);
    if (step.checkpoint === "provider.turn.quiesced") {
      const receipt = await Effect.runPromise(
        harness.waitForReceipt(
          (candidate): candidate is TurnProcessingQuiescedReceipt =>
            candidate.type === "turn.processing.quiesced" && candidate.threadId === THREAD_ID,
          step.timeoutMs,
        ),
        { signal: operation.signal },
      );
      return observation(step.checkpoint, plannedStep.sequence, {
        checkpointTurnCount: receipt.checkpointTurnCount,
      });
    }
    throw new Error(`Unsupported NL1 checkpoint '${step.checkpoint}'.`);
  };

  const collectCorrectnessEvidence: NetworkLabAdapter["collectCorrectnessEvidence"] = async (
    _context,
    operation,
  ): Promise<CorrectnessEvidence> => {
    const { harness } = requirePrepared(state);
    operation.signal.throwIfAborted();
    const thread = await Effect.runPromise(
      harness.waitForThread(
        THREAD_ID,
        (candidate) =>
          candidate.latestTurn?.state === "completed" &&
          candidate.session?.status === "ready" &&
          candidate.messages.some(
            (message) => message.role === "assistant" && message.streaming === false,
          ),
      ),
      { signal: operation.signal },
    );
    const receiptOption = await Effect.runPromise(
      harness.getCommandReceipt(COMMAND_ID),
      { signal: operation.signal },
    );
    const receipt = Option.getOrNull(receiptOption);
    const commandEvents = Array.from(
      await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)), {
        signal: operation.signal,
      }),
    ).filter((event) => event.commandId === COMMAND_ID);
    const adapterHarness = harness.adapterHarness!;
    const providerSnapshot = await Effect.runPromise(adapterHarness.adapter.readThread(THREAD_ID), {
      signal: operation.signal,
    });
    const providerSendCount = adapterHarness.getSendTurnCalls(THREAD_ID).length;
    const projection = semanticProjection(thread);
    const projectionHash = sha256(canonicalJson(projection as never));
    const requestHashes = state.capturedRequests.map((request) => request.envelopeHash);
    const expectedEventTypes = ["thread.message-sent", "thread.turn-start-requested"];
    const assertions: Array<CorrectnessAssertion> = [
      {
        id: "one-terminal-receipt",
        passed:
          receipt?.status === "accepted" &&
          receipt.commandVariant === "thread.turn.start" &&
          receipt.envelopeFingerprint !== null,
        expected: { status: "accepted", variant: "thread.turn.start", fingerprint: "present" },
        observed: receipt
          ? {
              status: receipt.status,
              variant: receipt.commandVariant,
              fingerprint: receipt.envelopeFingerprint === null ? "missing" : "present",
            }
          : null,
      },
      {
        id: "one-command-event-set",
        passed: canonicalJson(commandEvents.map((event) => event.type)) === canonicalJson(expectedEventTypes),
        expected: expectedEventTypes,
        observed: commandEvents.map((event) => event.type),
      },
      {
        id: "one-provider-send",
        passed: providerSendCount === 1,
        expected: 1,
        observed: providerSendCount,
      },
      {
        id: "one-provider-turn",
        passed: providerSnapshot.turns.length === 1,
        expected: 1,
        observed: providerSnapshot.turns.length,
      },
      {
        id: "one-projected-turn",
        passed:
          thread.messages.filter((message) => message.role === "user").length === 1 &&
          thread.messages.filter((message) => message.role === "assistant").length === 1 &&
          thread.latestTurn?.state === "completed",
        expected: { userMessages: 1, assistantMessages: 1, state: "completed" },
        observed: {
          userMessages: thread.messages.filter((message) => message.role === "user").length,
          assistantMessages: thread.messages.filter((message) => message.role === "assistant").length,
          state: thread.latestTurn?.state ?? null,
        },
      },
      {
        id: "identical-command-envelope",
        passed:
          requestHashes.length >= 1 &&
          requestHashes.every((hash) => hash === requestHashes[0]) &&
          state.capturedRequests.every((request) => request.commandId === COMMAND_ID),
        expected: { commandId: COMMAND_ID, distinctEnvelopeHashes: 1 },
        observed: {
          commandIds: state.capturedRequests.map((request) => request.commandId),
          distinctEnvelopeHashes: new Set(requestHashes).size,
        },
      },
      {
        id: "receipt-sequence-replayed",
        passed:
          state.suppressedExit === null ||
          (state.retrySequence === state.suppressedExit.sequence &&
            receipt?.resultSequence === state.suppressedExit.sequence),
        expected: state.suppressedExit?.sequence ?? receipt?.resultSequence ?? null,
        observed: state.retrySequence ?? state.firstDispatchSequence,
      },
    ];
    state.finalThread = thread;
    state.finalReceipt = receipt;
    state.commandEvents = commandEvents;
    state.providerTurnCount = providerSnapshot.turns.length;
    state.semanticProjection = projection;
    state.semanticHash = projectionHash;
    const normalizedControlTranscript = canonicalJson({
      controls: state.controlOperations.map((operation) => ({
        stepId: operation.stepId,
        sequence: operation.sequence,
        decisionToken: operation.decisionToken,
        effectiveControl: operation.effectiveControl,
      })),
      envelopeHashes: [...new Set(requestHashes)],
      suppressedCount: state.suppressedCount,
    });
    state.summary = {
      semanticProjection: projection,
      semanticHash: projectionHash,
      commandEventTypes: commandEvents.map((event) => event.type),
      providerSendCount,
      providerTurnCount: providerSnapshot.turns.length,
      capturedRequests: [...state.capturedRequests],
      suppressedExit: state.suppressedExit,
      normalizedControlTranscript,
    };
    if (assertions.every((assertion) => assertion.passed)) {
      return {
        status: "passed",
        assertions: assertions as ReadonlyArray<CorrectnessAssertion & { readonly passed: true }>,
      };
    }
    return { status: "failed", assertions };
  };

  const collectFaultEvidence: NetworkLabAdapter["collectFaultEvidence"] = async (
    _context,
    operation,
  ): Promise<FaultEvidence> => {
    operation.signal.throwIfAborted();
    const applyControls = state.controlOperations.filter(
      (operation) =>
        operation.effectiveControl.kind === "protocol-suppression" &&
        operation.effectiveControl.lifecycle === "apply",
    );
    const validApply =
      applyControls.length === 0 ||
      (state.suppressedCount === 1 &&
        state.suppressedExit !== null &&
        state.clientLinkClosedAfterSuppression &&
        state.firstDispatchWasAmbiguous &&
        state.commitProofFailure === null &&
        state.droppedNonTargetFrames === 0);
    const operations = state.controlOperations.map((operation) => ({
      ...operation,
      details: {
        ...operation.details,
        suppressedCount: state.suppressedCount,
        commitProved: state.suppressedExit !== null,
        receiptSequence: state.suppressedExit?.sequence ?? null,
        clientLinkClosed: state.clientLinkClosedAfterSuppression,
        droppedNonTargetFrames: state.droppedNonTargetFrames,
        commitProofFailure: state.commitProofFailure,
      },
    }));
    return {
      status: validApply ? "passed" : "failed",
      originPathUnshaped: true,
      operations,
    };
  };

  const cleanupResource: NetworkLabAdapter["cleanupResource"] = async (
    resource,
    _context,
    operation,
  ): Promise<CleanupResourceEvidence> => {
    operation.signal.throwIfAborted();
    if (resource.kind === "client-link") {
      const alreadyReleased = state.clientLinkReleased;
      state.clientLinkReleased = state.activeClientSessions === 0;
      return {
        ...resource,
        released: state.clientLinkReleased,
        details: { alreadyReleased, activeSessions: state.activeClientSessions },
        error: state.clientLinkReleased ? null : "Client RPC sessions are still active.",
      };
    }
    if (resource.kind === "origin-server") {
      const alreadyReleased = state.originReleased;
      if (!state.originReleased && state.origin) {
        await state.origin.dispose();
        state.originReleased = true;
      }
      return {
        ...resource,
        released: state.originReleased,
        details: { alreadyReleased, runtimeDisposed: state.originReleased },
        error: state.originReleased ? null : "Origin runtime was unavailable.",
      };
    }
    if (resource.kind === "orchestration-runtime") {
      const alreadyReleased = state.orchestrationReleased;
      if (!state.orchestrationReleased && state.harness) {
        await Effect.runPromise(state.harness.dispose, { signal: operation.signal });
        state.orchestrationReleased = true;
      }
      return {
        ...resource,
        released: state.orchestrationReleased,
        details: { alreadyReleased, runtimeDisposed: state.orchestrationReleased },
        error: state.orchestrationReleased ? null : "Orchestration runtime was unavailable.",
      };
    }
    if (resource.kind === "temporary-directory") {
      const alreadyReleased = state.temporaryDirectoryReleased;
      if (!state.temporaryDirectoryReleased && state.orchestrationScope) {
        await Effect.runPromise(Scope.close(state.orchestrationScope, Exit.void), {
          signal: operation.signal,
        });
        try {
          await NodeFSP.stat(resource.id);
          state.temporaryDirectoryReleased = false;
        } catch (error) {
          state.temporaryDirectoryReleased =
            isRecord(error) && "code" in error && error.code === "ENOENT";
        }
      }
      return {
        ...resource,
        released: state.temporaryDirectoryReleased,
        details: { alreadyReleased, pathAbsent: state.temporaryDirectoryReleased },
        error: state.temporaryDirectoryReleased ? null : "Temporary directory still exists.",
      };
    }
    return {
      ...resource,
      released: false,
      details: {},
      error: `Unknown NL1 resource kind '${resource.kind}'.`,
    };
  };

  return {
    provenance: NETWORK_RECOVERY_PROVENANCE,
    prepare,
    executeAction,
    executeControl,
    waitForCheckpoint,
    collectCorrectnessEvidence,
    collectFaultEvidence,
    cleanupResource,
    readSummary: () => state.summary,
    retryCleanup: async () => {
      if (!state.lease) return [];
      const controller = new AbortController();
      return await Promise.all(
        state.lease.resources.map((resource) =>
          cleanupResource(resource, {} as ScenarioExecutionPlan, {
            signal: controller.signal,
            lease: state.lease,
          }),
        ),
      );
    },
  };
}

export function recoveryCommandForTest(): ClientOrchestrationCommand {
  return frozenCommand;
}
