import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  clearThreadFindHit,
  clearThreadFindHitFor,
  openThreadFindAtHit,
  threadFindHitAtom,
} from "./thread-find-store";

const match = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  source: "assistant" as const,
  messageId: MessageId.make("message"),
  snippet: "Deploy the API",
  messageCreatedAt: null,
};

describe("thread search hits", () => {
  beforeEach(() => clearThreadFindHit());

  it("opens find on the matched message with the trimmed query", () => {
    openThreadFindAtHit(match, "  Deploy API ");
    expect(appAtomRegistry.get(threadFindHitAtom)).toEqual({
      environmentId: match.environmentId,
      threadId: match.threadId,
      messageId: match.messageId,
      query: "Deploy API",
    });
  });

  it("ignores hits from servers that do not name the message", () => {
    const { messageId: _, ...withoutMessage } = match;
    openThreadFindAtHit(withoutMessage, "deploy");
    expect(appAtomRegistry.get(threadFindHitAtom)).toBeNull();
  });

  it("keeps a hit just picked for another thread when the reader leaves this one", () => {
    openThreadFindAtHit(match, "deploy");
    clearThreadFindHitFor(match.environmentId, ThreadId.make("other"));
    expect(appAtomRegistry.get(threadFindHitAtom)).not.toBeNull();
    clearThreadFindHitFor(match.environmentId, match.threadId);
    expect(appAtomRegistry.get(threadFindHitAtom)).toBeNull();
  });
});
