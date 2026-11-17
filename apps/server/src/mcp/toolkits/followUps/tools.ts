import {
  EnvironmentId,
  FollowUp,
  FollowUpFields,
  FollowUpId,
  FollowUpLink,
  FollowUpStatus,
  FollowUpType,
  FollowUpTypeField,
  MessageId,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ServerConfig } from "../../../config.ts";
import * as FollowUps from "../../../followUps/FollowUps.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FollowUps.FollowUps,
    PeerForwarding.PeerForwarding,
    ServerConfig,
  ],
};

/** `link` names the home, so a forwarded result opens in the store that keeps it. */
export const LinkedFollowUp = Schema.Struct({
  ...FollowUp.fields,
  link: Schema.optional(Schema.String),
});

export const FollowUpsResult = Schema.Struct({
  followUps: Schema.Array(LinkedFollowUp),
  types: Schema.Array(FollowUpType),
});

export const FollowUpsTool = Tool.make("follow_ups", {
  ...shared,
  description:
    "Follow-ups are things worth doing later, kept for the user across threads and machines. Search before you write one, so you update it instead of adding a duplicate. Words in `query` match title, tags, type and body; `ids` reads exact ones. `status` defaults to open and picked_up. The result also lists the follow-up types agents defined. In your reply, name a follow-up by its `link` verbatim.",
  parameters: Schema.Struct({
    query: Schema.optional(Schema.String),
    ids: Schema.optional(Schema.Array(FollowUpId)),
    status: Schema.optional(Schema.Array(FollowUpStatus)),
    tags: Schema.optional(Schema.Array(Schema.String)),
    type: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: FollowUpsResult,
})
  .annotate(Tool.Title, "Search follow-ups")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

export const FollowUpFromThread = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.optional(EnvironmentId),
  messageId: Schema.optional(MessageId),
  quote: Schema.optional(Schema.String),
});

export const FollowUpSaveResult = Schema.Struct({
  followUp: Schema.optional(LinkedFollowUp),
  type: Schema.optional(FollowUpType),
});

export const FollowUpSaveTool = Tool.make("follow_up_save", {
  ...shared,
  description:
    "Write down a follow-up so it doesn't depend on the user's memory, or change one (`id`). Updating one or writing nothing are normal outcomes. The body stands on its own. T3 records this thread as its origin; `fromThread` names another thread it came from. `dueAt` brings it back to the user's inbox then; `condition` is a moment in plain words a nightly pass checks. Tags are loose, projects included. Reuse a type, or define one with its fields in `defineType`. Close with `status` done or dropped and a `result`, or merge a duplicate with `mergeInto`. `picked_up` means this thread works on it. In your reply, name it by its `link` verbatim.",
  parameters: Schema.Struct({
    id: Schema.optional(FollowUpId),
    title: Schema.optional(TrimmedNonEmptyString),
    body: Schema.optional(Schema.String),
    status: Schema.optional(FollowUpStatus),
    dueAt: Schema.optional(Schema.NullOr(Schema.String)),
    condition: Schema.optional(Schema.NullOr(Schema.String)),
    tags: Schema.optional(Schema.Array(Schema.String)),
    links: Schema.optional(Schema.Array(FollowUpLink)),
    type: Schema.optional(Schema.NullOr(Schema.String)),
    fields: Schema.optional(FollowUpFields),
    result: Schema.optional(Schema.String),
    mergeInto: Schema.optional(FollowUpId),
    fromThread: Schema.optional(FollowUpFromThread),
    defineType: Schema.optional(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        description: Schema.String,
        fields: Schema.Array(FollowUpTypeField),
      }),
    ),
  }),
  success: FollowUpSaveResult,
})
  .annotate(Tool.Title, "Save a follow-up")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const FollowUpsToolkit = Toolkit.make(FollowUpsTool, FollowUpSaveTool);
