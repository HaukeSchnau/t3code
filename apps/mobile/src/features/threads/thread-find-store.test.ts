import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  clearThreadFindHitFor,
  openThreadFindAtHit,
  threadFindHitAtom,
  threadFindPreferencesAtom,
  updateThreadFindPreferences,
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
  beforeEach(() => {
    updateThreadFindPreferences({ query: "", caseSensitive: true, wholeWord: true, regex: true });
  });

  it("matches the way thread search does, which ignores case", () => {
    openThreadFindAtHit(match, "  Deploy API ");
    expect(appAtomRegistry.get(threadFindPreferencesAtom)).toEqual({
      query: "deploy api",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      scope: "all",
    });
    expect(appAtomRegistry.get(threadFindHitAtom)?.query).toBe("deploy api");
  });

  it("drops the hit once the reader edits find", () => {
    openThreadFindAtHit(match, "deploy");
    updateThreadFindPreferences({ wholeWord: true });
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
