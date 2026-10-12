/**
 * Turn-item bodies for OpenCode tool calls, shared by the 1.x and 2.x runtimes.
 * Both report a tool as a name, a JSON input, text output, and free-form
 * metadata; only how they deliver those differs.
 */
import type { OrchestrationV2FileChangeDetail, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { formatReadToolLabel, formatSearchToolLabel } from "@t3tools/shared/toolActivity";

type ToolItemBase = Omit<
  Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
  "type" | "toolName" | "input" | "output"
>;

export function openCodeToolProjectionKind(
  toolName: string,
): "command_execution" | "file_change" | "file_search" | "web_search" | "dynamic_tool" {
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite") {
    return "dynamic_tool";
  }
  if (normalized.includes("bash") || normalized.includes("shell")) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web") || normalized === "codesearch" || normalized === "code_search") {
    return "web_search";
  }
  if (normalized === "read") {
    return "dynamic_tool";
  }
  if (
    normalized.includes("glob") ||
    normalized.includes("grep") ||
    normalized.includes("search") ||
    normalized.includes("lsp")
  ) {
    return "file_search";
  }
  return "dynamic_tool";
}

function recordString(input: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function recordNumber(input: unknown, ...keys: ReadonlyArray<string>): number | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stableJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Files an apply_patch call touches. The finished call's metadata lists them;
 * while it runs, only the patch text's file headers name them.
 */
function patchFileChanges(
  input: Record<string, unknown>,
  completedMetadata: unknown,
): Array<OrchestrationV2FileChangeDetail> {
  const files =
    typeof completedMetadata === "object" && completedMetadata !== null
      ? (completedMetadata as Record<string, unknown>).files
      : undefined;
  if (Array.isArray(files)) {
    return files.flatMap((file): Array<OrchestrationV2FileChangeDetail> => {
      const path = recordString(file, "filePath")?.trim();
      const operation = recordString(file, "type")?.trim();
      if (path === undefined || operation === undefined) return [];
      const movePath = recordString(file, "movePath")?.trim();
      return [
        movePath === undefined
          ? { operation, path }
          : { operation: "move", path: movePath, oldPath: path },
      ];
    });
  }
  const changes: Array<OrchestrationV2FileChangeDetail> = [];
  for (const line of (recordString(input, "patchText") ?? "").split(/\r?\n/)) {
    const file = /^\*\*\* (Add|Update|Delete) File:(.+)$/.exec(line);
    const path = file?.[2]?.trim();
    if (file?.[1] !== undefined && path) {
      changes.push({ operation: file[1].toLowerCase(), path });
      continue;
    }
    const movePath = /^\*\*\* Move to:(.+)$/.exec(line)?.[1]?.trim();
    const previous = changes.at(-1);
    if (movePath && previous?.operation === "update") {
      changes[changes.length - 1] = { operation: "move", path: movePath, oldPath: previous.path };
    }
  }
  return changes;
}

/**
 * The turn item for one tool call. `completedMetadata` is the tool's metadata
 * once it succeeded: exit codes and diffs are only trusted from a finished call.
 */
export function openCodeToolTurnItem(
  base: ToolItemBase,
  tool: {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly output: string | undefined;
    readonly completedMetadata: unknown;
  },
): OrchestrationV2TurnItem {
  const { input, output } = tool;
  switch (openCodeToolProjectionKind(tool.name)) {
    case "command_execution": {
      const exitCode = recordNumber(tool.completedMetadata, "exit", "exitCode");
      const cwd = recordString(input, "workdir")?.trim();
      return {
        ...base,
        type: "command_execution",
        input: recordString(input, "command", "cmd") ?? stableJson(input),
        ...(cwd === undefined ? {} : { cwd }),
        ...(output === undefined ? {} : { output }),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    }
    case "file_change": {
      const oldStr = recordString(input, "oldString", "oldText");
      const newStr = recordString(input, "newString", "content", "newText");
      const diffStr = recordString(tool.completedMetadata, "diff", "patch");
      const changes = tool.name.toLowerCase().includes("patch")
        ? patchFileChanges(input, tool.completedMetadata)
        : [];
      return {
        ...base,
        type: "file_change",
        fileName: changes[0]?.path ?? recordString(input, "filePath", "path", "file") ?? tool.name,
        ...(changes.length === 0 ? {} : { changes }),
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
        ...(diffStr === undefined ? {} : { diffStr }),
      };
    }
    case "file_search": {
      const pattern = recordString(input, "pattern", "query", "path", "filePath");
      return {
        ...base,
        title:
          formatSearchToolLabel({ input, ...(pattern === undefined ? {} : { pattern }) }) ??
          base.title,
        type: "file_search",
        ...(pattern === undefined ? {} : { pattern }),
      };
    }
    case "web_search": {
      const pattern = recordString(input, "query", "url", "pattern");
      return {
        ...base,
        type: "web_search",
        ...(pattern === undefined ? {} : { patterns: [pattern] }),
      };
    }
    case "dynamic_tool": {
      const readPath = recordString(input, "filePath", "path", "file");
      return {
        ...base,
        title:
          tool.name.toLowerCase() === "read" && readPath !== undefined
            ? formatReadToolLabel(readPath)
            : base.title,
        type: "dynamic_tool",
        toolName: tool.name,
        input,
        ...(output === undefined ? {} : { output }),
      };
    }
  }
}
