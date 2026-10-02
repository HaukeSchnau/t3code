import type {
  EnvironmentId,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  ThreadGlance,
  ThreadGlanceList,
  ThreadGlanceRow,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";

import { singlePendingQuestion } from "./threadReply.ts";

// Fork: compact thread state for the Apple Watch. See patches/apple-watch.md.

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_RECENT_ROWS = 20;
const EXCERPT_LIMIT = 280;

const isFinished = (phase: ThreadGlanceRow["phase"]) => phase === "completed" || phase === "failed";

// Attention first, then failures, then work in flight, then finished work.
function phaseRank(phase: ThreadGlanceRow["phase"]): number {
  switch (phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return 0;
    case "failed":
      return 1;
    case "starting":
    case "running":
      return 2;
    default:
      return 3;
  }
}

/**
 * The watch's thread list for one environment: every thread whose agent needs the user or is
 * working, plus finished threads from the last day that haven't been settled yet.
 */
export function buildThreadGlanceList(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: Pick<OrchestrationShellSnapshot, "projects" | "threads">;
  readonly nowMs: number;
}): ThreadGlanceList {
  const projectsById = new Map(input.snapshot.projects.map((project) => [project.id, project]));
  const rows = input.snapshot.threads.flatMap((thread): ReadonlyArray<ThreadGlanceRow> => {
    const project = projectsById.get(thread.projectId);
    if (!project || thread.archivedAt !== null) return [];
    const state = projectThreadAwareness({ environmentId: input.environmentId, project, thread });
    if (!state) return [];
    if (
      isFinished(state.phase) &&
      (thread.settledAt !== null || input.nowMs - Date.parse(state.updatedAt) > RECENT_WINDOW_MS)
    ) {
      return [];
    }
    return [
      {
        environmentId: state.environmentId,
        threadId: state.threadId,
        projectTitle: state.projectTitle,
        threadTitle: state.threadTitle,
        phase: state.phase,
        updatedAt: state.updatedAt,
      },
    ];
  });
  const sorted = rows.toSorted(
    (left, right) =>
      phaseRank(left.phase) - phaseRank(right.phase) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  const active = sorted.filter((row) => !isFinished(row.phase) || row.phase === "failed");
  const finished = sorted.filter((row) => row.phase === "completed").slice(0, MAX_RECENT_ROWS);
  return { threads: [...active, ...finished] };
}

/** One thread for the watch's thread card. */
export function buildThreadGlance(input: {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<OrchestrationProjectShell, "title">;
  readonly thread: OrchestrationThreadShell;
  // The latest turn's messages are enough for the excerpt.
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text">>;
  readonly openRequests: ReadonlyArray<OrchestrationThreadActivity>;
}): ThreadGlance {
  const { thread } = input;
  const state = projectThreadAwareness({
    environmentId: input.environmentId,
    project: input.project,
    thread,
  });
  const phase = state?.phase ?? null;
  const latestAgentText = input.messages.findLast(
    (message) => message.role === "assistant" && message.text.trim() !== "",
  )?.text;
  const excerpt = latestAgentText === undefined ? undefined : glanceExcerpt(latestAgentText);
  const pending = thread.hasPendingUserInput ? singlePendingQuestion(input.openRequests) : null;
  return {
    environmentId: input.environmentId,
    threadId: thread.id,
    projectTitle: input.project.title,
    threadTitle: thread.title,
    modelTitle: thread.modelSelection.model,
    phase,
    updatedAt: thread.updatedAt,
    ...(excerpt === undefined ? {} : { excerpt }),
    ...(pending
      ? {
          question: {
            text: pending.question.question,
            options: pending.question.options.map((option) => option.label),
            allowsFreeText: pending.question.allowCustomAnswer !== false,
          },
        }
      : {}),
    // A turn is in flight, including one blocked on the user.
    canStop: phase !== null && !isFinished(phase),
  };
}

/**
 * Agent messages are Markdown. A watch shows plain text, so this drops code blocks and
 * formatting, collapses whitespace, and keeps the opening, which is usually the summary.
 */
export function glanceExcerpt(markdown: string, limit = EXCERPT_LIMIT): string | undefined {
  const plain = markdown
    .replace(/```[\s\S]*?(```|$)/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+\.|>)\s+/gmu, "")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/gu, "$2")
    .replace(/\s+/gu, " ")
    .trim();
  if (plain === "") return undefined;
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > limit * 0.6 ? cut.slice(0, wordEnd) : cut).trimEnd()}…`;
}
