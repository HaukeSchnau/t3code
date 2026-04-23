import { renderTerminalOutput } from "./terminalOutput";

export interface ToolContextField {
  label: string;
  value: string;
  format?: "text" | "code" | "json";
}

export interface ToolContextFileChange {
  path: string;
  kind?: string;
  diff?: string;
}

export interface ToolContextPresentation {
  heading: string;
  preview?: string;
  status?: "running" | "completed" | "failed";
  parameters: ToolContextField[];
  outputs: ToolContextField[];
  fileChanges: ToolContextFileChange[];
  rawPayload?: unknown;
}

const KNOWN_CODEX_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "dynamicToolCall",
  "mcpToolCall",
  "webSearch",
  "collabAgentToolCall",
]);

const PAYLOAD_ITEM_TYPE_TO_CODEX_ITEM_TYPE = {
  command_execution: "commandExecution",
  file_change: "fileChange",
  dynamic_tool_call: "dynamicToolCall",
  mcp_tool_call: "mcpToolCall",
  web_search: "webSearch",
  collab_agent_tool_call: "collabAgentToolCall",
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function trimInlineWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function hasInferredCodexItemShape(
  item: Record<string, unknown>,
  itemType: (typeof PAYLOAD_ITEM_TYPE_TO_CODEX_ITEM_TYPE)[keyof typeof PAYLOAD_ITEM_TYPE_TO_CODEX_ITEM_TYPE],
): boolean {
  switch (itemType) {
    case "commandExecution":
      return (
        asTrimmedString(item.command) !== null ||
        asTrimmedString(asRecord(item.input)?.command) !== null ||
        asTrimmedString(asRecord(item.result)?.command) !== null ||
        asTrimmedString(item.aggregatedOutput) !== null ||
        asNumber(item.exitCode) !== null ||
        asNumber(item.durationMs) !== null
      );
    case "fileChange":
      return Array.isArray(item.changes);
    case "dynamicToolCall":
      return (
        asTrimmedString(item.tool) !== null ||
        asTrimmedString(item.namespace) !== null ||
        item.arguments !== undefined ||
        item.contentItems !== undefined ||
        asBoolean(item.success) !== null
      );
    case "mcpToolCall":
      return (
        asTrimmedString(item.server) !== null ||
        asTrimmedString(item.tool) !== null ||
        item.arguments !== undefined ||
        item.result !== undefined ||
        item.error !== undefined
      );
    case "webSearch":
      return asTrimmedString(item.query) !== null || item.action !== undefined;
    case "collabAgentToolCall":
      return (
        asTrimmedString(item.tool) !== null ||
        asTrimmedString(item.prompt) !== null ||
        asTrimmedString(item.model) !== null ||
        asTrimmedString(item.reasoningEffort) !== null ||
        Array.isArray(item.receiverThreadIds) ||
        item.agentsStates !== undefined
      );
  }
}

function truncateInline(value: string, maxLength = 160): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

function formatDurationMs(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 0) {
    return null;
  }
  if (durationMs < 1_000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function stringifyPretty(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (value === undefined) {
    return null;
  }
  try {
    const json = JSON.stringify(value, null, 2);
    return json && json !== "null" ? json : null;
  } catch {
    return null;
  }
}

function stringifyInline(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return truncateInline(trimInlineWhitespace(direct));
  }
  if (value === undefined) {
    return null;
  }
  try {
    const json = JSON.stringify(value);
    return json && json !== "null" ? truncateInline(json) : null;
  } catch {
    return null;
  }
}

function firstTextLine(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    const firstLine = direct
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine ? truncateInline(firstLine) : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = firstTextLine(entry);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  for (const key of ["text", "content", "message", "result", "summary", "query"]) {
    const nested = firstTextLine(record[key]);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function pushField(
  target: ToolContextField[],
  label: string,
  value: unknown,
  format: ToolContextField["format"] = "text",
): void {
  const normalized =
    format === "json"
      ? stringifyPretty(value)
      : format === "code"
        ? stringifyPretty(value)
        : stringifyPretty(value);
  if (!normalized) {
    return;
  }
  target.push({ label, value: normalized, format });
}

function normalizeStatus(input: {
  activityKind?: string | undefined;
  payloadStatus?: unknown;
  itemStatus?: unknown;
  success?: boolean | null;
}): ToolContextPresentation["status"] {
  const statusSource =
    asTrimmedString(input.itemStatus)?.toLowerCase() ??
    asTrimmedString(input.payloadStatus)?.toLowerCase();
  if (statusSource?.includes("fail") || statusSource?.includes("error")) {
    return "failed";
  }
  if (
    statusSource?.includes("progress") ||
    statusSource === "pending" ||
    statusSource === "running"
  ) {
    return "running";
  }
  if (statusSource?.includes("complete") || statusSource?.includes("success")) {
    return "completed";
  }
  if (input.success === false) {
    return "failed";
  }
  if (input.success === true) {
    return "completed";
  }
  if (input.activityKind === "tool.started") {
    return "running";
  }
  if (input.activityKind === "tool.updated") {
    return "running";
  }
  if (input.activityKind === "tool.completed") {
    return "completed";
  }
  return undefined;
}

function deriveCommandExecutionContext(
  item: Record<string, unknown>,
  rawPayload: unknown,
  activityKind?: string,
  payloadStatus?: unknown,
): ToolContextPresentation {
  const parameters: ToolContextField[] = [];
  const outputs: ToolContextField[] = [];
  const rawAggregatedOutput = stringifyPretty(item.aggregatedOutput);
  const aggregatedOutput = rawAggregatedOutput ? renderTerminalOutput(rawAggregatedOutput) : null;
  const preview = firstTextLine(aggregatedOutput);
  const status = normalizeStatus({
    activityKind,
    payloadStatus,
    itemStatus: item.status,
  });

  pushField(parameters, "Command", item.command, "code");
  pushField(parameters, "Working directory", item.cwd, "code");
  pushField(outputs, "Output", aggregatedOutput, "code");
  pushField(outputs, "Exit code", asNumber(item.exitCode), "text");
  pushField(outputs, "Duration", formatDurationMs(asNumber(item.durationMs)), "text");

  return {
    heading: "Ran command",
    ...(preview ? { preview } : {}),
    ...(status ? { status } : {}),
    parameters,
    outputs,
    fileChanges: [],
    rawPayload,
  };
}

function deriveFileChangeContext(
  item: Record<string, unknown>,
  rawPayload: unknown,
  activityKind?: string,
  payloadStatus?: unknown,
): ToolContextPresentation {
  const fileChanges = Array.isArray(item.changes)
    ? item.changes.flatMap<ToolContextFileChange>((entry) => {
        const record = asRecord(entry);
        const path = asTrimmedString(record?.path);
        if (!path) {
          return [];
        }
        return [
          {
            path,
            ...(asTrimmedString(record?.kind) ? { kind: asTrimmedString(record?.kind)! } : {}),
            ...(stringifyPretty(record?.diff) ? { diff: stringifyPretty(record?.diff)! } : {}),
          },
        ];
      })
    : [];
  const preview =
    fileChanges.length > 0
      ? `${fileChanges[0]!.path}${fileChanges.length > 1 ? ` +${fileChanges.length - 1} more` : ""}`
      : null;
  const status = normalizeStatus({
    activityKind,
    payloadStatus,
    itemStatus: item.status,
  });

  const outputs: ToolContextField[] = [];
  if (fileChanges.length > 0) {
    outputs.push({
      label: "Files changed",
      value: `${fileChanges.length} file${fileChanges.length === 1 ? "" : "s"}`,
      format: "text",
    });
  }

  return {
    heading: "Edited files",
    ...(preview ? { preview } : {}),
    ...(status ? { status } : {}),
    parameters: [],
    outputs,
    fileChanges,
    rawPayload,
  };
}

function deriveDynamicToolCallContext(
  item: Record<string, unknown>,
  rawPayload: unknown,
  activityKind?: string,
  payloadStatus?: unknown,
): ToolContextPresentation {
  const parameters: ToolContextField[] = [];
  const outputs: ToolContextField[] = [];
  const namespace = asTrimmedString(item.namespace);
  const tool = asTrimmedString(item.tool) ?? "Dynamic tool";
  const contentItemsPreview = firstTextLine(item.contentItems);
  const status = normalizeStatus({
    activityKind,
    payloadStatus,
    itemStatus: item.status,
    success: asBoolean(item.success),
  });

  pushField(parameters, "Tool", tool, "text");
  pushField(parameters, "Namespace", namespace, "text");
  pushField(parameters, "Arguments", item.arguments, "json");
  pushField(outputs, "Output content", item.contentItems, "json");
  pushField(outputs, "Success", asBoolean(item.success), "text");
  pushField(outputs, "Duration", formatDurationMs(asNumber(item.durationMs)), "text");

  return {
    heading: namespace ? `${namespace}/${tool}` : tool,
    ...(contentItemsPreview ? { preview: contentItemsPreview } : {}),
    ...(status ? { status } : {}),
    parameters,
    outputs,
    fileChanges: [],
    rawPayload,
  };
}

function deriveMcpToolCallContext(
  item: Record<string, unknown>,
  rawPayload: unknown,
  activityKind?: string,
  payloadStatus?: unknown,
): ToolContextPresentation {
  const parameters: ToolContextField[] = [];
  const outputs: ToolContextField[] = [];
  const server = asTrimmedString(item.server) ?? "mcp";
  const tool = asTrimmedString(item.tool) ?? "tool";
  const preview = firstTextLine(item.result) ?? firstTextLine(item.error);
  const status = normalizeStatus({
    activityKind,
    payloadStatus,
    itemStatus: item.status,
  });

  pushField(parameters, "Arguments", item.arguments, "json");
  pushField(outputs, "Result", item.result, "json");
  pushField(outputs, "Error", item.error, "json");
  pushField(outputs, "Duration", formatDurationMs(asNumber(item.durationMs)), "text");

  return {
    heading: `${server}/${tool}`,
    ...(preview ? { preview } : {}),
    ...(status ? { status } : {}),
    parameters,
    outputs,
    fileChanges: [],
    rawPayload,
  };
}

function deriveWebSearchContext(
  item: Record<string, unknown>,
  rawPayload: unknown,
  activityKind?: string,
  payloadStatus?: unknown,
): ToolContextPresentation {
  const parameters: ToolContextField[] = [];
  const outputs: ToolContextField[] = [];
  const preview = asTrimmedString(item.query) ?? firstTextLine(item.action);
  const status = normalizeStatus({
    activityKind,
    payloadStatus,
    itemStatus: item.status,
  });

  pushField(parameters, "Query", item.query, "text");
  pushField(parameters, "Action", item.action, "json");
  pushField(outputs, "Action summary", stringifyInline(item.action), "text");

  return {
    heading: "Web search",
    ...(preview ? { preview } : {}),
    ...(status ? { status } : {}),
    parameters,
    outputs,
    fileChanges: [],
    rawPayload,
  };
}

function deriveCollabAgentToolCallContext(
  item: Record<string, unknown>,
  rawPayload: unknown,
  activityKind?: string,
  payloadStatus?: unknown,
): ToolContextPresentation {
  const parameters: ToolContextField[] = [];
  const outputs: ToolContextField[] = [];
  const tool = asTrimmedString(item.tool) ?? "collabAgentToolCall";
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const preview = firstTextLine(item.prompt) ?? receiverThreadIds[0] ?? null;
  const status = normalizeStatus({
    activityKind,
    payloadStatus,
    itemStatus: item.status,
  });

  pushField(parameters, "Prompt", item.prompt, "code");
  pushField(parameters, "Model", item.model, "text");
  pushField(parameters, "Reasoning effort", item.reasoningEffort, "text");
  if (receiverThreadIds.length > 0) {
    outputs.push({
      label: "Receivers",
      value: receiverThreadIds.join("\n"),
      format: "code",
    });
  }
  pushField(outputs, "Status", item.status, "text");
  pushField(outputs, "Agent states", item.agentsStates, "json");

  return {
    heading: tool,
    ...(preview ? { preview } : {}),
    ...(status ? { status } : {}),
    parameters,
    outputs,
    fileChanges: [],
    rawPayload,
  };
}

export function hasToolContextDetails(toolContext: ToolContextPresentation | undefined): boolean {
  if (!toolContext) {
    return false;
  }
  return (
    toolContext.parameters.length > 0 ||
    toolContext.outputs.length > 0 ||
    toolContext.fileChanges.length > 0 ||
    toolContext.rawPayload !== undefined
  );
}

export function deriveCodexToolContextPresentation(input: {
  payload: Record<string, unknown> | null;
  activityKind?: string | undefined;
}): ToolContextPresentation | null {
  const data = asRecord(input.payload?.data);
  const item = asRecord(data?.item);
  const inferredItemType =
    typeof input.payload?.itemType === "string"
      ? (PAYLOAD_ITEM_TYPE_TO_CODEX_ITEM_TYPE[
          input.payload.itemType as keyof typeof PAYLOAD_ITEM_TYPE_TO_CODEX_ITEM_TYPE
        ] ?? null)
      : null;
  const itemType =
    asTrimmedString(item?.type) ??
    (item && inferredItemType && hasInferredCodexItemShape(item, inferredItemType)
      ? inferredItemType
      : null);
  if (!item || !itemType || !KNOWN_CODEX_ITEM_TYPES.has(itemType)) {
    return null;
  }

  switch (itemType) {
    case "commandExecution":
      return deriveCommandExecutionContext(item, data, input.activityKind, input.payload?.status);
    case "fileChange":
      return deriveFileChangeContext(item, data, input.activityKind, input.payload?.status);
    case "dynamicToolCall":
      return deriveDynamicToolCallContext(item, data, input.activityKind, input.payload?.status);
    case "mcpToolCall":
      return deriveMcpToolCallContext(item, data, input.activityKind, input.payload?.status);
    case "webSearch":
      return deriveWebSearchContext(item, data, input.activityKind, input.payload?.status);
    case "collabAgentToolCall":
      return deriveCollabAgentToolCallContext(
        item,
        data,
        input.activityKind,
        input.payload?.status,
      );
    default:
      return null;
  }
}
