import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";

import * as ThreadControlHttp from "./http.ts";
import * as ThreadControl from "./ThreadControl.ts";

const missing = (threadId: ThreadId) =>
  Effect.fail(new ThreadControl.ThreadControlThreadNotFoundError({ threadId }));

class ThreadControlTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.threadControl,
) {}

// The phone's native code sends only a bearer token: no protocol header, and no body for Stop.
it.effect("serves the phone's requests with the orchestration scopes", () =>
  Effect.gen(function* () {
    let scopes: ReadonlyArray<AuthEnvironmentScope> = [];
    const stopped: Array<ThreadId> = [];
    const routes = HttpApiBuilder.layer(ThreadControlTestApi).pipe(
      Layer.provide(ThreadControlHttp.layer),
      Layer.provide(
        Layer.mock(ThreadControl.ThreadControl)({
          reply: ({ threadId }) =>
            threadId === "missing" ? missing(threadId) : Effect.succeed({ outcome: "sent" }),
          stop: (threadId) =>
            threadId === "missing"
              ? missing(threadId)
              : Effect.sync(() => void stopped.push(threadId)),
          listGlances: () => Effect.succeed({ threads: [] }),
          getGlance: (threadId) => missing(threadId),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token",
                scopes: new Set(scopes),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const call = (method: "GET" | "POST", path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://localhost${path}`, {
            method,
            ...(body === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          }),
        );
        return response.status;
      });
    const requests = () =>
      Effect.all([
        call("GET", "/api/orchestration/glance"),
        call("POST", "/api/orchestration/threads/thread-1/reply", { replyId: "r", text: "Go" }),
        call("POST", "/api/orchestration/threads/thread-1/stop"),
      ]);

    expect(yield* requests()).toEqual([403, 403, 403]);
    scopes = ["orchestration:read"];
    expect(yield* requests()).toEqual([200, 403, 403]);
    scopes = ["orchestration:read", "orchestration:operate"];
    expect(yield* requests()).toEqual([200, 200, 204]);
    expect(stopped).toEqual(["thread-1"]);
    // The phone stops retrying a deleted thread only on a 404.
    expect(
      yield* Effect.all([
        call("POST", "/api/orchestration/threads/missing/reply", { replyId: "r", text: "Go" }),
        call("POST", "/api/orchestration/threads/missing/stop"),
        call("GET", "/api/orchestration/threads/missing/glance"),
      ]),
    ).toEqual([404, 404, 404]);
  }),
);
