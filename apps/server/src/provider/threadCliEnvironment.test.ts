import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { T3CODE_THREAD_ID_ENV, withThreadCliEnvironment } from "./threadCliEnvironment.ts";

it("adds the T3 caller thread without mutating the provider environment", () => {
  const source = { PATH: "/bin", T3CODE_THREAD_ID: "stale-thread" };
  const result = withThreadCliEnvironment(source, ThreadId.make("current-thread"));

  assert.deepEqual(source, { PATH: "/bin", T3CODE_THREAD_ID: "stale-thread" });
  assert.equal(result.PATH, "/bin");
  assert.equal(result[T3CODE_THREAD_ID_ENV], "current-thread");
});
