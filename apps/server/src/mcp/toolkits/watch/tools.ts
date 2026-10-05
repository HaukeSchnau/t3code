import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentWatches from "../../../watches/AgentWatches.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AgentWatches.AgentWatches,
  ],
};

const WatchTool = Tool.make("t3_watch", {
  ...shared,
  description:
    "Wait for something without spending tokens. T3 Code keeps watching after your turn ends and across server restarts, then wakes this thread with a notification: it starts the thread when idle and queues behind an active turn. " +
    'source {type:"thread",threadId,runId?} fires once when that run completes, fails, is interrupted, or is cancelled, in any project. Use it to be woken by a thread you started with t3_thread_launch: pass the runId it returned (t3_thread_send and delegate_task return run ids too); a run that already finished fires at once. Without runId it follows the active run, else the next queued run, else the latest run, else the thread\'s first run. ' +
    'source {type:"command",command,cwd?} runs a long-lived shell command on the server in this thread\'s workspace (cwd is relative to it). Each burst of stdout/stderr lines wakes you with those lines; a burst identical to the previous one is skipped, so print only lines worth waking for. When the command exits the watch closes and wakes you once more with the exit status. Command watches need a full-access thread. ' +
    'deadline (ISO date-time or a duration such as "30 minutes") closes the watch without waking you. Manage watches with t3_watch_list and t3_watch_cancel.',
  parameters: Schema.Struct({
    source: AgentWatches.WatchSourceInput,
    label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
    deadline: Schema.optional(Schema.String),
  }),
  success: AgentWatches.AgentWatch,
})
  .annotate(Tool.Title, "Watch and wake this thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const WatchListTool = Tool.make("t3_watch_list", {
  ...shared,
  description:
    "List this thread's watches, newest first. Closed watches are included only with includeClosed.",
  parameters: Schema.Struct({ includeClosed: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ watches: Schema.Array(AgentWatches.AgentWatch) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WatchCancelTool = Tool.make("t3_watch_cancel", {
  ...shared,
  description:
    "Cancel one of this thread's watches. A command watch stops its command. Cancelling a closed watch returns it unchanged.",
  parameters: Schema.Struct({ watchId: AgentWatches.WatchId }),
  success: AgentWatches.AgentWatch,
}).annotate(Tool.Destructive, true);

export const WatchToolkit = Toolkit.make(WatchTool, WatchListTool, WatchCancelTool);
