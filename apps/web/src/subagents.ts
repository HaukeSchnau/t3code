import { type OrchestrationThreadActivity } from "@t3tools/contracts";

export type SubagentRuntimeStatus = "running" | "waiting" | "completed" | "failed" | "unknown";

export interface SubagentWorkEntry {
  providerThreadId: string;
  receiverThreadIds: ReadonlyArray<string>;
  label: string;
  status: SubagentRuntimeStatus;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  lastActivity?: string;
}

export interface SubagentTimelineEntry extends SubagentWorkEntry {
  transcript: string;
  startedAt: string;
  updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const text = asString(entry);
    return text ? [text] : [];
  });
}

export function normalizeSubagentStatus(value: unknown): SubagentRuntimeStatus {
  switch (value) {
    case "running":
    case "inProgress":
    case "in_progress":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function collabAgentItemFromPayload(payload: Record<string, unknown> | null) {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  if (item?.type === "collabAgentToolCall") {
    return item;
  }
  if (data?.type === "collabAgentToolCall") {
    return data;
  }
  return null;
}

function collabAgentStateForThread(
  item: Record<string, unknown>,
  providerThreadId: string,
): Record<string, unknown> | null {
  const agentsStates = asRecord(item.agentsStates);
  return asRecord(agentsStates?.[providerThreadId]);
}

function subagentLabel(input: {
  providerThreadId: string;
  item: Record<string, unknown> | null;
  state: Record<string, unknown> | null;
}): string {
  const message = asString(input.state?.message);
  if (message) {
    return message;
  }
  const tool = asString(input.item?.tool);
  if (tool === "spawnAgent") {
    return "Spawned subagent";
  }
  if (tool === "wait") {
    return "Subagent update";
  }
  if (tool === "closeAgent") {
    return "Closed subagent";
  }
  return `Subagent ${input.providerThreadId.slice(0, 8)}`;
}

export function extractSubagentWorkEntryFromPayload(
  payload: Record<string, unknown> | null,
): SubagentWorkEntry | null {
  if (payload?.itemType !== "collab_agent_tool_call") {
    return null;
  }
  const item = collabAgentItemFromPayload(payload);
  const receiverThreadIds = asStringArray(item?.receiverThreadIds);
  const providerThreadId = receiverThreadIds[0];
  if (!item || !providerThreadId) {
    return null;
  }
  const state = collabAgentStateForThread(item, providerThreadId);
  const status = normalizeSubagentStatus(state?.status ?? item.status);
  const prompt = asString(item.prompt) ?? undefined;
  const model = asString(item.model) ?? undefined;
  const reasoningEffort = asString(item.reasoningEffort) ?? undefined;
  const lastActivity = asString(state?.message) ?? undefined;

  return {
    providerThreadId,
    receiverThreadIds,
    label: subagentLabel({ providerThreadId, item, state }),
    status,
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(lastActivity ? { lastActivity } : {}),
  };
}

function subagentProjectionFromActivity(activity: OrchestrationThreadActivity) {
  if (activity.kind !== "subagent.thread") {
    return null;
  }
  const payload = asRecord(activity.payload);
  const providerThreadId = asString(payload?.providerThreadId);
  if (!providerThreadId) {
    return null;
  }
  return {
    providerThreadId,
    status: normalizeSubagentStatus(payload?.status),
    transcript: asString(payload?.transcript) ?? "",
    lastActivity: asString(payload?.lastActivity) ?? undefined,
    updatedAt: asString(payload?.updatedAt) ?? activity.createdAt,
  };
}

export function deriveSubagentTimelineEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): SubagentTimelineEntry[] {
  const byProviderThreadId = new Map<string, SubagentTimelineEntry>();

  for (const activity of [...activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const payload = asRecord(activity.payload);
    const workEntry = extractSubagentWorkEntryFromPayload(payload);
    if (workEntry) {
      const existing = byProviderThreadId.get(workEntry.providerThreadId);
      byProviderThreadId.set(workEntry.providerThreadId, {
        ...existing,
        ...workEntry,
        transcript: existing?.transcript ?? "",
        startedAt: existing?.startedAt ?? activity.createdAt,
        updatedAt: existing?.updatedAt ?? activity.createdAt,
      });
      continue;
    }

    const projection = subagentProjectionFromActivity(activity);
    if (!projection) {
      continue;
    }
    const existing = byProviderThreadId.get(projection.providerThreadId);
    const nextEntry: SubagentTimelineEntry = {
      providerThreadId: projection.providerThreadId,
      receiverThreadIds: existing?.receiverThreadIds ?? [projection.providerThreadId],
      label: existing?.label ?? `Subagent ${projection.providerThreadId.slice(0, 8)}`,
      status: projection.status === "unknown" ? (existing?.status ?? "unknown") : projection.status,
      transcript: projection.transcript,
      startedAt: existing?.startedAt ?? activity.createdAt,
      updatedAt: projection.updatedAt,
    };
    if (existing?.prompt) {
      nextEntry.prompt = existing.prompt;
    }
    if (existing?.model) {
      nextEntry.model = existing.model;
    }
    if (existing?.reasoningEffort) {
      nextEntry.reasoningEffort = existing.reasoningEffort;
    }
    const lastActivity = projection.lastActivity ?? existing?.lastActivity;
    if (lastActivity) {
      nextEntry.lastActivity = lastActivity;
    }
    byProviderThreadId.set(projection.providerThreadId, nextEntry);
  }

  return [...byProviderThreadId.values()].toSorted((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}
