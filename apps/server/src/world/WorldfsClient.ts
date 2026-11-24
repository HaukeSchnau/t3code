// @effect-diagnostics nodeBuiltinImport:off -- the worldfs control socket is a Unix socket with one JSON line each way.
/**
 * The worldfs daemon's control socket (`native/worldfs/README.md`). T3's server runs in the
 * host mount namespace, so it calls as the host and names the thread explicitly.
 */
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WorldfsError extends Schema.TaggedError<WorldfsError>()("WorldfsError", {
  /** The daemon's code, such as `cap` or `work`, or `unavailable` when it could not be asked. */
  code: Schema.String,
  message: Schema.String,
}) {}

export function worldfsSocketPath(configured: string, environment: NodeJS.ProcessEnv): string {
  if (configured !== "") return configured;
  const runtime = environment.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
  return NodePath.join(runtime, "worldfs", "ctl.sock");
}

const Failure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const isFailure = Schema.is(Failure);

/** Sends one request and returns the daemon's successful response as parsed JSON. */
export const worldfsRequest = Effect.fn("Worldfs.request")(function* (
  socket: string,
  body: Readonly<Record<string, unknown>>,
  timeoutMs: number,
) {
  const response = yield* Effect.callback<unknown, WorldfsError>((resume) => {
    const connection = NodeNet.createConnection(socket);
    let buffer = "";
    let done = false;
    const finish = (result: Effect.Effect<unknown, WorldfsError>) => {
      if (done) return;
      done = true;
      connection.destroy();
      resume(result);
    };
    const unavailable = (message: string) =>
      finish(Effect.fail(new WorldfsError({ code: "unavailable", message })));
    connection.setTimeout(timeoutMs, () =>
      unavailable(`The worldfs daemon did not answer within ${timeoutMs} ms.`),
    );
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(`${JSON.stringify(body)}\n`));
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(Effect.succeed(JSON.parse(buffer.slice(0, newline))));
      } catch {
        unavailable("The worldfs daemon sent a response that is not JSON.");
      }
    });
    connection.on("error", (error: NodeJS.ErrnoException) =>
      unavailable(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? `The worldfs daemon is not running (${socket}).`
          : `The worldfs daemon could not be reached: ${error.message}`,
      ),
    );
    connection.on("end", () => unavailable("The worldfs daemon closed the connection."));
    return Effect.sync(() => connection.destroy());
  });
  if (isFailure(response)) {
    return yield* new WorldfsError({
      code: response.error.code,
      message: response.error.message,
    });
  }
  return response;
});
