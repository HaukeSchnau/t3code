import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  TRIAGE_PROMPT_FILE_NAME,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  approvalRedirectNotice,
  composerDraftContentChanged,
  approvalsForComposerRedirect,
  composerDraftChangedSinceSend,
  multipleModelSendBlock,
  sendPlacesThread,
} from "./composerSend.logic";

const local = EnvironmentId.make("local");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");

it("detects draft edits during upload preparation without treating upload metadata as an edit", () => {
  const draft: ComposerThreadDraftState = {
    prompt: "before",
    images: [],
    files: [
      {
        type: "file",
        id: "file",
        name: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        file: null,
      },
    ],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    inlineReplies: [],
    replyTo: null,
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
  expect(
    composerDraftContentChanged(draft, {
      ...draft,
      files: [{ ...draft.files[0]!, uploadedAttachmentId: "upload", uploadEnvironmentId: local }],
    }),
  ).toBe(false);
  expect(composerDraftContentChanged(draft, { ...draft, prompt: "after" })).toBe(true);
  expect(composerDraftContentChanged(draft, { ...draft, files: [] })).toBe(true);
  expect(composerDraftContentChanged(draft, { ...draft, threadContexts: [localThread] })).toBe(
    true,
  );
});

describe("multipleModelSendBlock", () => {
  const ready = {
    selectionCount: 2,
    serverSupportsWorktreeBootstrap: true,
    isLocalDraftThread: true,
    isGitRepo: true,
    branch: "main",
  };

  it("lets a new Git draft with a branch and models start", () => {
    expect(multipleModelSendBlock(ready)).toBeNull();
  });

  it("asks for a server update before checking the draft", () => {
    expect(
      multipleModelSendBlock({
        ...ready,
        serverSupportsWorktreeBootstrap: false,
        isGitRepo: false,
      }),
    ).toBe("server-outdated");
  });

  it.each([
    { isLocalDraftThread: false },
    { isGitRepo: false },
    { branch: null },
    { selectionCount: 0 },
  ])("needs a new Git thread with a branch and models (%o)", (override) => {
    expect(multipleModelSendBlock({ ...ready, ...override })).toBe("needs-new-git-thread");
  });
});

describe("approvalRedirectNotice", () => {
  const settled = {
    draftChanged: false,
    declined: true,
    approvalResponding: false,
    approvalArrived: false,
  };

  it("says the decline went through when the draft changed after it", () => {
    expect(approvalRedirectNotice({ ...settled, draftChanged: true })).toBe(
      "Approval declined. Your message changed, so it wasn't sent.",
    );
    expect(approvalRedirectNotice({ ...settled, draftChanged: true, declined: false })).toBe(
      "Your message changed, so it wasn't sent.",
    );
  });

  it("explains an approval already being answered", () => {
    expect(
      approvalRedirectNotice({ ...settled, declined: false, approvalResponding: true }),
    ).toMatch(/already being answered/);
  });

  it("explains an approval that arrived during the decline", () => {
    expect(approvalRedirectNotice({ ...settled, approvalArrived: true })).toMatch(
      /Another approval arrived/,
    );
  });

  it("stays quiet when the decline failed or the user left the thread", () => {
    expect(approvalRedirectNotice({ ...settled, declined: false })).toBeNull();
    expect(approvalRedirectNotice(settled)).toBeNull();
  });
});

describe("sendPlacesThread", () => {
  it.each([
    {
      name: "places a plain Auto send",
      autoPlacement: true,
      repositories: undefined,
      prompt: "Fix it",
      placed: true,
    },
    {
      name: "keeps a manual send here",
      autoPlacement: false,
      repositories: undefined,
      prompt: "Fix it",
      placed: false,
    },
    {
      name: "keeps a repository choice, which names this machine's paths, here",
      autoPlacement: true,
      repositories: [{ path: "/work/api" }],
      prompt: "Fix it",
      placed: false,
    },
    {
      name: "keeps a triage prompt, which links this machine's playbook, here",
      autoPlacement: true,
      repositories: undefined,
      prompt: `[${TRIAGE_PROMPT_FILE_NAME}](/tmp/triage/${TRIAGE_PROMPT_FILE_NAME}) and triage`,
      placed: false,
    },
    {
      name: "keeps a checked-out pull request, which is this machine's checkout, here",
      autoPlacement: true,
      repositories: undefined,
      prompt: "Fix it",
      placed: false,
      checksOutPullRequest: true,
    },
  ])("$name", ({ autoPlacement, repositories, prompt, placed, checksOutPullRequest = false }) => {
    expect(
      sendPlacesThread({
        autoPlacement,
        worktreeRepositories: repositories,
        prompt,
        checksOutPullRequest,
      }),
    ).toBe(placed);
  });
});

describe("approvalsForComposerRedirect", () => {
  it("leaves approvals alone when queueing and redirects only shown approvals when steering", () => {
    const shown = {
      requestId: RuntimeRequestId.make("shown"),
      requestKind: "command" as const,
      responseCapability: "live" as const,
      supportsFeedback: true,
      createdAt: "2026-11-05T00:00:00.000Z",
    };
    const held = { ...shown, requestId: RuntimeRequestId.make("held") };
    const input = {
      approvals: [shown, held],
      shownApprovalIds: [shown.requestId],
      sameThread: true,
    };
    expect(approvalsForComposerRedirect({ ...input, dispatchMode: "queue" })).toEqual([]);
    expect(approvalsForComposerRedirect({ ...input, dispatchMode: "steer" })).toEqual([shown]);
    expect(
      approvalsForComposerRedirect({ ...input, dispatchMode: "steer", sameThread: false }),
    ).toEqual([]);
  });
});

describe("composerDraftChangedSinceSend", () => {
  const sent = {
    pendingAttachments: false,
    prompt: "Queue this",
    sentPrompts: ["Queue this"],
    attachmentIds: ["upload"],
    sentAttachmentIds: ["upload"],
    annotationImageId: undefined,
  };

  it("catches text, attachments and pastes added while the send uploads", () => {
    expect(composerDraftChangedSinceSend(sent)).toBe(false);
    expect(composerDraftChangedSinceSend({ ...sent, prompt: "Queue this too" })).toBe(true);
    expect(composerDraftChangedSinceSend({ ...sent, attachmentIds: ["upload", "added"] })).toBe(
      true,
    );
    expect(composerDraftChangedSinceSend({ ...sent, pendingAttachments: true })).toBe(true);
  });

  it("ignores the annotation a direct annotation send writes into the draft", () => {
    const annotated = {
      ...sent,
      sentPrompts: ["Queue this", "Queue this @annotation"],
      sentAttachmentIds: ["upload", "annotation"],
      annotationImageId: "annotation",
    };
    expect(composerDraftChangedSinceSend(annotated)).toBe(false);
    expect(composerDraftChangedSinceSend({ ...annotated, prompt: "Queue this @annotation" })).toBe(
      false,
    );
    expect(
      composerDraftChangedSinceSend({ ...annotated, attachmentIds: ["upload", "annotation"] }),
    ).toBe(false);
  });
});
