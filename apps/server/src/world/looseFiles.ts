// @effect-diagnostics nodeBuiltinImport:off -- walks a thread world on the host.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { ManagedWorkspaceError } from "../workspace/WorkspaceCommand.ts";

/**
 * Files in a thread world that belong to no repo, as the host sees it: repos the thread never
 * checked out are empty mount points there, and a checked-out repo has a `.git` file the daemon
 * accounts for. With `includeRepos`, files inside repos count too.
 */
export function looseFiles(
  root: string,
  options: { readonly includeRepos?: boolean; readonly limit?: number } = {},
): string[] {
  const limit = options.limit ?? 10;
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0 && found.length < limit) {
    const directory = stack.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!options.includeRepos && entries.some((entry) => entry.name === ".git")) continue;
    for (const entry of entries) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else found.push(NodePath.relative(root, path));
    }
  }
  return found.slice(0, limit);
}

/**
 * Removes `root` and the empty directories below it, and fails as soon as one holds anything,
 * so a file written while the caller decided is never deleted.
 */
export const removeEmptyTree = (root: string) =>
  Effect.try({
    try: () => {
      const remove = (directory: string) => {
        for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) remove(NodePath.join(directory, entry.name));
        }
        NodeFS.rmdirSync(directory);
      };
      remove(root);
    },
    catch: (cause) =>
      new ManagedWorkspaceError({
        operation: "removeEmptyTree",
        detail: `${root} is not empty`,
        cause,
      }),
  });
