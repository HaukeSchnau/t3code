import { captureToFollowUp } from "@t3tools/client-runtime/state/follow-ups";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type FollowUpOrigin,
  type FollowUpSaveInput,
} from "@t3tools/contracts";

/** The capture sheet's route params. Quoting a thread's message sets them; a bare capture has none. */
export type FollowUpCaptureParams = {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly quote?: string;
  readonly threadTitle?: string;
};

/** Never throws: the params may come from a deep link. */
export function captureOriginFromParams(
  params: FollowUpCaptureParams | undefined,
): FollowUpOrigin | null {
  const quote = params?.quote?.trim();
  if (!params?.environmentId || !params.threadId || !quote) return null;
  try {
    return {
      environmentId: EnvironmentId.make(params.environmentId),
      threadId: ThreadId.make(params.threadId),
      messageId: params.messageId ? MessageId.make(params.messageId) : null,
      quote,
      threadTitle: params.threadTitle?.trim() || null,
    };
  } catch {
    return null;
  }
}

/** What saving the capture creates, or null while there is nothing to save. */
export function followUpCaptureInput(
  text: string,
  origin: FollowUpOrigin | null,
): FollowUpSaveInput | null {
  const note = captureToFollowUp(text);
  if (origin === null) return note;
  // A quote saved without a title takes its first line; the nightly pass tidies it later.
  const title = note?.title ?? captureToFollowUp(origin.quote ?? "")?.title;
  return title === undefined ? null : { title, body: note?.body ?? "", origin };
}
