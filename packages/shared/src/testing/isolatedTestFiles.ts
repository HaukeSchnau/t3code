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

// Vitest 5.0.1's VM pools reuse a module's compiled code across environments. After a jsdom file, a
// worker hands node files the browser transform of the modules they share. Vitest 5.0.3 fixes this
// (vitest#11395), so the rule can go with the upgrade to vite-plus 1.1.0.
const otherEnvironment = /@vitest-environment\s+(?!node\b)\S/;

/**
 * Of `files` under `root`, those that can't run in a VM pool worker alongside other files: those
 * that pick an environment other than node, and `known`, which fail in a VM context or change state
 * that every file in the worker shares.
 */
export const vmIncompatibleTestFiles = (
  root: string,
  files: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
) =>
  files.filter(
    (file) =>
      known.includes(file) ||
      otherEnvironment.test(NodeFS.readFileSync(NodePath.join(root, file), "utf8")),
  );
