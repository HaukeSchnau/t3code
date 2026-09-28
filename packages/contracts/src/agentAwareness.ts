import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  RelayAgentActivitySnapshotResponse,
  RelayDeviceRegistrationRequest,
  RelayDeviceUnregistrationParams,
  RelayLiveActivityRegistrationRequest,
} from "./relay.ts";

export {
  RelayAgentActivitySnapshotResponse as AgentAwarenessSnapshot,
  RelayDeviceRegistrationRequest as AgentAwarenessDeviceRegistrationInput,
  RelayDeviceUnregistrationParams as AgentAwarenessDeviceUnregistrationInput,
  RelayLiveActivityRegistrationRequest as AgentAwarenessLiveActivityRegistrationInput,
};

export const AgentAwarenessRegistrationResult = Schema.Struct({
  accepted: Schema.Literal(true),
  deliveryConfigured: Schema.Boolean,
});
export type AgentAwarenessRegistrationResult = typeof AgentAwarenessRegistrationResult.Type;

export class AgentAwarenessServiceError extends Schema.TaggedError<AgentAwarenessServiceError>()(
  "AgentAwarenessServiceError",
  {
    message: Schema.String,
  },
) {}

/**
 * Free text sent to a thread from a surface without a composer, such as a notification's
 * Reply action. The server decides what the text means: the answer to the thread's pending
 * question, or a message that starts a turn or queues behind the running one.
 *
 * `replyId` is the idempotency key. A retry reuses it and gets `already_delivered` once the
 * first attempt was accepted.
 */
export const ThreadReplyInput = Schema.Struct({
  replyId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type ThreadReplyInput = typeof ThreadReplyInput.Type;

/** Why a reply can't be delivered without the full client. */
export const ThreadReplyRejectionReason = Schema.Literals([
  // An approval blocks the thread, and text can't approve or deny it.
  "approval_pending",
  // The pending question has several parts, or couldn't be read back.
  "question_needs_client",
  // The question only accepts its listed options, and the text matched none.
  "no_matching_option",
]);
export type ThreadReplyRejectionReason = typeof ThreadReplyRejectionReason.Type;

export const ThreadReplyResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literals(["answered", "sent", "already_delivered"]) }),
  Schema.Struct({ outcome: Schema.Literal("rejected"), reason: ThreadReplyRejectionReason }),
]);
export type ThreadReplyResult = typeof ThreadReplyResult.Type;
