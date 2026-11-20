import {
  makeNeedsYouDraftStore,
  needsYouDeckKey,
} from "@t3tools/client-runtime/state/needs-you-triage";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type OrchestrationMessageContext,
  type ThreadId,
} from "@t3tools/contracts";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { enqueueThreadOutboxMessage, threadOutboxManager } from "../../state/thread-outbox";

const queuedMessages = threadOutboxManager.queuedMessagesByThreadKeyAtom;

export const triageDrafts = makeNeedsYouDraftStore({
  holds: (messageId) =>
    Object.values(appAtomRegistry.get(queuedMessages)).some((messages) =>
      messages.some((message) => message.messageId === messageId),
    ),
  subscribe: (listener) => appAtomRegistry.subscribe(queuedMessages, listener),
});

interface TriageThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * A reply is a user message, which ends every open ask of the thread. It is on its way until
 * the outbox delivers or drops it.
 */
export async function queueTriageMessage(
  target: TriageThread,
  text: string,
  context?: OrchestrationMessageContext,
) {
  const messageId = MessageId.make(uuidv4());
  await enqueueThreadOutboxMessage({
    environmentId: target.environmentId,
    threadId: target.threadId,
    messageId,
    commandId: CommandId.make(uuidv4()),
    text,
    ...(context === undefined ? {} : { context }),
    attachments: [],
    dispatchMode: "queue",
    createdAt: new Date().toISOString(),
  });
  return { queued: messageId };
}

/** The sends of a page on a triage card, also expanded full screen, one at a time with the card's. */
export function triagePageSend(target: TriageThread) {
  const key = needsYouDeckKey({ environmentId: target.environmentId, id: target.threadId });
  return (message: { readonly text: string; readonly context: OrchestrationMessageContext }) =>
    triageDrafts.sendFromPage(key, () => queueTriageMessage(target, message.text, message.context));
}
