import { assert, it } from "@effect/vitest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { withProjectExecution, projectExecutionArguments } from "./ProjectExecution.ts";

it("wraps both sides of a pipeline while preserving cwd, env and pipe options", () => {
  const source = ChildProcess.make("printf", ["a b"], { cwd: "/project", env: { TOKEN: "value" } });
  const destination = ChildProcess.make("cat", [], { cwd: "/project" });
  const wrapped = withProjectExecution(ChildProcess.pipeTo(source, destination), "/bin/agent-exec");
  assert.equal(wrapped._tag, "PipedCommand");
  if (wrapped._tag !== "PipedCommand") return;
  for (const part of [wrapped.left, wrapped.right]) {
    assert.equal(part._tag, "StandardCommand");
    if (part._tag !== "StandardCommand") continue;
    assert.equal(part.command, "/bin/agent-exec");
    assert.equal(part.options.cwd, "/project");
  }
  if (wrapped.left._tag === "StandardCommand") {
    assert.deepEqual(wrapped.left.args, ["auto", "--cwd", "/project", "--", "printf", "a b"]);
    assert.deepEqual(wrapped.left.options.env, { TOKEN: "value" });
  }
});

it("leaves host probes and unconfigured environments unchanged", () => {
  const command = ChildProcess.make("codex", ["--version"]);
  assert.strictEqual(withProjectExecution(command, "/bin/agent-exec"), command);
  assert.strictEqual(withProjectExecution(command, undefined), command);
});

it("keeps shell metacharacters literal when constructing terminal arguments", () => {
  assert.deepEqual(
    projectExecutionArguments("/project with spaces", "/bin/bash", ["-c", "echo $HOME"]),
    ["auto", "--cwd", "/project with spaces", "--", "/bin/bash", "-c", "echo $HOME"],
  );
});
