import {
  JjAction,
  JjRunActionResult,
  JjStatus,
  JjThreadWorkResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as JjStatusReader from "../../../jj/JjStatusReader.ts";
import * as JjThreadWork from "../../../jj/JjThreadWork.ts";
import * as JjWorkflow from "../../../jj/JjWorkflow.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const JjStatusTool = Tool.make("t3_jj_status", {
  description:
    "Read the jj change stack of this thread's working copy: changes from trunk() to @ with their T3-Thread and T3-Turn trailers, bookmarks, push state and conflicts, plus files in @ that no turn could be attributed to. Returns null outside a jj repository. Reading does not snapshot the working copy.",
  success: Schema.NullOr(JjStatus),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    JjStatusReader.JjStatusReader,
  ],
})
  .annotate(Tool.Title, "Read the jj change stack")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const JjActionTool = Tool.make("t3_jj_action", {
  description:
    "Run a jj action in this thread's working copy, the same way the T3 app does: describe (an omitted message is written by T3's commit writer), commit (optionally only some paths), new, squash into parent, abandon, split, absorb, edit, bookmark set/rename/delete, push (creates a t3code/<slug> bookmark when the change has none), pr (push and open a pull request), fetch, rebase onto trunk(), and undo of an operation T3 ran. Actions that rewrite files on disk (new, edit, abandon, rebase, undo) refuse while a turn is running in the working copy, which includes your own turn, so prefer running jj directly for those.",
  parameters: Schema.Struct({ action: JjAction }),
  success: JjRunActionResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    JjWorkflow.JjWorkflow,
  ],
})
  .annotate(Tool.Title, "Run a jj action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const JjThreadWorkTool = Tool.make("t3_jj_thread_work", {
  description:
    "Find this thread's jj work in every repository T3 knows on this environment: changes whose T3-Thread trailer names this thread, with their turns and push state, and how many recent jj operations the thread's agent ran there. Use it to see what a thread changed across repositories.",
  success: JjThreadWorkResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    JjThreadWork.JjThreadWork,
  ],
})
  .annotate(Tool.Title, "Find a thread's jj work")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const JjToolkit = Toolkit.make(JjStatusTool, JjActionTool, JjThreadWorkTool);
