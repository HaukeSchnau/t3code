// @effect-diagnostics nodeBuiltinImport:off - read by Vitest configs, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// A mocked module or a stubbed global only reaches modules evaluated after it. When files share a
// module graph, an earlier file has usually evaluated those modules already.
const sharedStateApi = /\bvi\.(?:mock|doMock|stubGlobal|stubEnv)\(/;

/**
 * The test files under `root` matching `patterns` that need a module graph of their own: those that
 * mock modules or stub globals, and `known`, which break with shared modules for other reasons.
 */
export const isolatedTestFiles = (
  root: string,
  patterns: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
) => {
  const files = NodeFS.globSync([...patterns], { cwd: root, exclude: ["**/node_modules/**"] }).map(
    (file) => file.replaceAll("\\", "/"),
  );
  const isolated = files.filter((file) =>
    sharedStateApi.test(NodeFS.readFileSync(NodePath.join(root, file), "utf8")),
  );
  return [...new Set([...isolated, ...known])];
};
