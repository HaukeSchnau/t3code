import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  type OrchestrationThreadActivity,
  type ThreadReplyRejectionReason,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Fork: free-text replies from notification actions. See patches/notification-replies.md.

/** What a free-text reply means for a thread, given its pending requests. */
export type ThreadReplyPlan =
  | {
      readonly _tag: "Answer";
      readonly requestId: ApprovalRequestId;
      readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>>;
    }
  | { readonly _tag: "Message" }
  | { readonly _tag: "Rejected"; readonly reason: ThreadReplyRejectionReason };

const decodeQuestions = Schema.decodeUnknownOption(
  Schema.Struct({ questions: Schema.Array(UserInputQuestion) }),
);

/** The reply's command id. Retries of one reply share it, which makes them idempotent. */
export const threadReplyCommandId = (replyId: string) => CommandId.make(`thread-reply:${replyId}`);
export const threadReplyMessageId = (replyId: string) => MessageId.make(`thread-reply:${replyId}`);

/**
 * Decides what a reply does. A pending question takes the text as its answer when it is the
 * only question; otherwise the text becomes a message, which starts a turn or queues behind
 * the running one. `openRequests` comes from the decider's scan of the thread's activities.
 */
export function planThreadReply(input: {
  readonly text: string;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly openRequests: ReadonlyArray<OrchestrationThreadActivity>;
}): ThreadReplyPlan {
  if (input.hasPendingApprovals) return { _tag: "Rejected", reason: "approval_pending" };
  if (!input.hasPendingUserInput) return { _tag: "Message" };

  const pending = singlePendingQuestion(input.openRequests);
  if (!pending) return { _tag: "Rejected", reason: "question_needs_client" };
  const answer = matchUserInputAnswer(pending.question, input.text);
  if (answer === null) return { _tag: "Rejected", reason: "no_matching_option" };
  return {
    _tag: "Answer",
    requestId: pending.requestId,
    answers: { [pending.question.id]: answer },
  };
}

/**
 * The thread's pending question when there is exactly one request with exactly one part, which
 * is what a notification reply or the watch can answer. Anything else needs the full client.
 */
export function singlePendingQuestion(
  openRequests: ReadonlyArray<OrchestrationThreadActivity>,
): { readonly requestId: ApprovalRequestId; readonly question: UserInputQuestion } | null {
  const [request, ...others] = openRequests.filter(
    (activity) => activity.kind === "user-input.requested",
  );
  if (!request || others.length > 0) return null;
  const payload = decodeQuestions(request.payload);
  const requestId = (request.payload as { readonly requestId?: unknown }).requestId;
  if (Option.isNone(payload) || typeof requestId !== "string") return null;
  const [question, ...moreQuestions] = payload.value.questions;
  if (!question || moreQuestions.length > 0) return null;
  return { requestId: ApprovalRequestId.make(requestId), question };
}

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/u, "")
    .trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Maps a spoken or typed reply onto a question's options, the way the composer would submit
 * it: an option's value (or label), or the text itself when the question takes free answers.
 * Returns null when the question only accepts its options and the reply matched none.
 */
export function matchUserInputAnswer(
  question: UserInputQuestion,
  text: string,
): string | ReadonlyArray<string> | null {
  const reply = normalize(text);
  const pick = (index: number) => {
    const option = question.options[index]!;
    const value = option.value ?? option.label;
    return question.multiSelect ? [value] : value;
  };

  const exact = question.options.findIndex(
    (option) =>
      normalize(option.label) === reply ||
      (option.value !== undefined && normalize(option.value) === reply),
  );
  if (exact >= 0) return pick(exact);

  // "2", "two", "option 2": dictation produces both digits and words.
  const position = reply.match(/^(?:option\s+|number\s+)?(\w+)$/u)?.[1];
  if (position !== undefined) {
    const index = /^\d+$/u.test(position) ? Number(position) - 1 : NUMBER_WORDS.indexOf(position);
    if (index >= 0 && index < question.options.length) return pick(index);
  }

  // "Vitest please": exactly one option named inside a longer reply.
  const mentioned = question.options.flatMap((option, index) =>
    new RegExp(`(^|\\W)${escapeRegExp(normalize(option.label))}(\\W|$)`, "u").test(reply)
      ? [index]
      : [],
  );
  if (mentioned.length === 1) return pick(mentioned[0]!);

  return question.allowCustomAnswer === false ? null : text.trim();
}
