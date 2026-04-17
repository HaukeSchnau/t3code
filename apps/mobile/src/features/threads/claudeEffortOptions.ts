import type { ClaudeAgentEffort } from "@t3tools/contracts";

export const CLAUDE_AGENT_EFFORT_OPTIONS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
] as const satisfies readonly ClaudeAgentEffort[];
