import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HtmlRenderPage,
  type HtmlRenderPageChange,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createHtmlRenderEnvironmentAtoms, htmlRenderFrameInView } from "./htmlRender.ts";

describe("htmlRenderFrameInView", () => {
  it.each([
    { name: "half of a short frame", percentVisible: 50, percentOfScroller: 20, inView: true },
    { name: "a third of a short frame", percentVisible: 33, percentOfScroller: 15, inView: false },
    {
      name: "a tall frame filling the screen",
      percentVisible: 5,
      percentOfScroller: 100,
      inView: true,
    },
    {
      name: "a tenth of a tall frame, under half the screen",
      percentVisible: 10,
      percentOfScroller: 40,
      inView: false,
    },
    { name: "the edge of a tall frame", percentVisible: 2, percentOfScroller: 30, inView: false },
  ])("$name: $inView", ({ percentVisible, percentOfScroller, inView }) => {
    expect(htmlRenderFrameInView({ percentVisible, percentOfScroller })).toBe(inView);
  });
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("pages-environment"),
  label: "Pages environment",
  httpBaseUrl: "https://pages.example.test",
  wsBaseUrl: "wss://pages.example.test",
});

const PAGE: HtmlRenderPage = {
  renderId: "page-1",
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  threadTitle: "Layouts",
  title: "Settings layouts",
  latestAttachmentId: "page-1",
  firstPublishedAt: "2026-11-19T10:00:00.000Z",
  latestPublishedAt: "2026-11-19T10:00:00.000Z",
  versionCount: 1,
  seenAt: null,
  ask: null,
};

it.effect("reloads a list read before its change stream's first answer", () =>
  Effect.gen(function* () {
    const answers = yield* Queue.unbounded<HtmlRenderPageChange>();
    let indexed: ReadonlyArray<HtmlRenderPage> = [];
    let reads = 0;
    const client = {
      [WS_METHODS.htmlRenderListPages]: () =>
        Effect.sync(() => {
          reads += 1;
          return { pages: indexed, nextCursor: null };
        }),
      [WS_METHODS.htmlRenderSubscribePageChanges]: () => Stream.fromQueue(answers),
    } as unknown as WsRpcProtocolClient;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      }),
      session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const environments = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_environmentId, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const atoms = createHtmlRenderEnvironmentAtoms(
      Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
    );
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );
    const list = atoms.pages({
      environmentId: TARGET.environmentId,
      input: { threadId: PAGE.threadId, filter: "all" },
    });
    const listed = (count: number) =>
      AtomRegistry.toStream(registry, list).pipe(
        Stream.filter(
          (result) =>
            AsyncResult.isSuccess(result) && !result.waiting && result.value.pages.length === count,
        ),
        Stream.runHead,
      );
    yield* Effect.acquireRelease(
      Effect.sync(() => registry.mount(list)),
      (unmount) => Effect.sync(unmount),
    );

    // The server read the list, then a page was published before its change stream subscribed.
    yield* listed(0);
    indexed = [PAGE];
    yield* Queue.offer(answers, { revision: 0, pages: 1 });

    yield* listed(1);
    expect(reads).toBe(2);
  }).pipe(Effect.scoped),
);
