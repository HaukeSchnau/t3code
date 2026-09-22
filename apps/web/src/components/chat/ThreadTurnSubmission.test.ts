import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import {
  analyzeThreadTurnDraft,
  createDirectThreadTurnDeliveryAdapter,
  createDurableThreadTurnDeliveryAdapter,
  resolveFollowUpSubmissionTitle,
  resolveNewThreadSubmissionTitle,
  serializeThreadTurnPrompt,
  submitThreadTurn,
  threadComposerRevision,
  type ThreadComposerRevision,
  type ThreadTurnDraft,
  type ThreadTurnSubmissionTarget,
} from "./ThreadTurnSubmission";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("codex-default");

function image(id = "image-1"): ComposerImageAttachment {
  return {
    type: "image",
    id,
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 42,
    previewUrl: `blob:${id}`,
    file: { name: "screenshot.png" } as File,
  };
}

function draft(overrides: Partial<ThreadTurnDraft> = {}): ThreadTurnDraft {
  return {
    prompt: "Ship it",
    images: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    selectedProvider: ProviderDriverKind.make("codex"),
    selectedModel: "gpt-5.6",
    selectedProviderModels: [],
    selectedPromptEffort: null,
    selectedModelSelection: { instanceId, model: "gpt-5.6" },
    ...overrides,
  };
}

function target(overrides: Partial<ThreadTurnSubmissionTarget> = {}): ThreadTurnSubmissionTarget {
  return {
    environmentId,
    threadId,
    threadCreatedAt: "2026-08-09T10:00:00.000Z",
    threadWorktreePath: null,
    projectId,
    projectWorkspaceRoot: "/repo",
    projectDefaultModelSelection: null,
    isServerThread: true,
    isLocalDraftThread: false,
    isFirstMessage: false,
    queue: false,
    prepareWorkspace: false,
    activeBranch: "main",
    baseRevision: null,
    startFromOrigin: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  };
}

function emptyRevision(): ThreadComposerRevision {
  return {
    prompt: "",
    imageIds: [],
    fileIds: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
  };
}

describe("ThreadTurnSubmission", () => {
  it("analyzes and serializes sendable contexts in stable order", () => {
    const input = draft({
      prompt: "Inspect this",
      terminalContexts: [
        {
          id: "terminal-1",
          threadId,
          createdAt: "2026-08-09T10:00:00.000Z",
          terminalId: "term-1",
          terminalLabel: "Server",
          lineStart: 1,
          lineEnd: 2,
          text: "ready",
        },
        {
          id: "terminal-expired",
          threadId,
          createdAt: "2026-08-09T10:00:00.000Z",
          terminalId: "term-2",
          terminalLabel: "Expired",
          lineStart: 1,
          lineEnd: 1,
          text: "",
        },
      ],
      reviewComments: [
        {
          id: "review-1",
          sectionId: "section-1",
          sectionTitle: "Files",
          filePath: "src/a.ts",
          startIndex: 1,
          endIndex: 2,
          rangeLabel: "1-2",
          text: "Rename this",
          diff: "+old",
        },
      ],
    });

    const analysis = analyzeThreadTurnDraft(input);
    const serialized = serializeThreadTurnPrompt(input, analysis);

    assert.equal(analysis.expiredTerminalContextCount, 1);
    assert.equal(analysis.sendableTerminalContexts.length, 1);
    assert.equal(serialized, "Inspect this");
  });

  it("derives new-thread and follow-up titles without leaking command construction to callers", () => {
    const imageDraft = draft({ prompt: "", images: [image()] });
    const analysis = analyzeThreadTurnDraft(imageDraft);

    assert.equal(resolveNewThreadSubmissionTitle(imageDraft, analysis), "Image: screenshot.png");
    assert.equal(resolveFollowUpSubmissionTitle(analysis, "Existing title"), "Existing title");
  });

  it("uses durable and direct delivery adapters at the same command seam", async () => {
    const calls: string[] = [];
    const command = {
      type: "thread.message.queue" as const,
      commandId: CommandId.make("command-1"),
      threadId,
      message: {
        messageId: MessageId.make("message-1"),
        role: "user" as const,
        text: "x",
        attachments: [],
      },
      modelSelection: { instanceId, model: "gpt-5.6" },
      titleSeed: "x",
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    const durable = createDurableThreadTurnDeliveryAdapter({
      enqueue: async (nextEnvironmentId, nextCommand) => {
        calls.push(`durable:${nextEnvironmentId}:${nextCommand.type}`);
      },
    });
    const direct = createDirectThreadTurnDeliveryAdapter({
      dispatchCommand: async (nextCommand) => {
        calls.push(`direct:${nextCommand.type}`);
      },
    });

    await durable.deliver(environmentId, command);
    await direct.deliver(environmentId, command);

    assert.deepStrictEqual(calls, [
      "durable:env-1:thread.message.queue",
      "direct:thread.message.queue",
    ]);
  });

  it("queues an uploaded file with its context and preserves newer composer text", async () => {
    const inputDraft = draft({
      prompt: "Review the report",
      files: [
        {
          type: "file",
          id: "local-report",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
          file: null,
        },
      ],
      terminalContexts: [
        {
          id: "terminal-live",
          threadId,
          terminalId: "term-1",
          terminalLabel: "Build",
          createdAt: "2026-08-09T10:00:00.000Z",
          lineStart: 1,
          lineEnd: 1,
          text: "build passed",
        },
        {
          id: "terminal-expired",
          threadId,
          terminalId: "term-2",
          terminalLabel: "Expired",
          createdAt: "2026-08-09T10:00:00.000Z",
          lineStart: 1,
          lineEnd: 1,
          text: "",
        },
      ],
    });
    useAttachmentUploadStore.setState({
      uploadsByImageId: {
        "local-report": { status: "ready", environmentId, attachmentId: "pending-report" },
      },
    });
    let cleared = false;
    try {
      const result = await submitThreadTurn({
        draft: inputDraft,
        target: target({ queue: true }),
        title: "Report",
        delivery: createDurableThreadTurnDeliveryAdapter({
          enqueue: async (_environmentId, command) => {
            assert.equal(command.type, "thread.message.queue");
            assert.equal(command.message.attachments[0]?.id, "pending-report");
            assert.deepEqual(
              command.message.context?.records.map((record) => record.kind),
              ["terminal", "file"],
            );
            assert.include(JSON.stringify(command.message.context), "build passed");
            assert.notInclude(JSON.stringify(command.message.context), "terminal-expired");
            assert.include(JSON.stringify(command.message.context), "pending-report");
          },
        }),
        composer: {
          clearOnSuccess: "if-current",
          readCurrentRevision: () =>
            threadComposerRevision({ ...inputDraft, prompt: "Another request" }),
          clear: () => {
            cleared = true;
          },
        },
        makeCommandId: () => CommandId.make("command-report"),
        makeMessageId: () => MessageId.make("message-report"),
        now: () => "2026-08-09T10:00:00.000Z",
      });
      assert.equal(result.kind, "delivered");
      if (result.kind === "delivered")
        assert.equal(result.prepared.optimisticMessage.attachments?.[0]?.type, "file");
      assert.equal(cleared, false);
    } finally {
      useAttachmentUploadStore.setState({ uploadsByImageId: {} });
    }
  });

  it.each([undefined, "git-detached"] as const)(
    "builds an attachment send with workspace kind %s",
    async (workspaceKind) => {
      const delivered: unknown[] = [];
      const inputDraft = draft({ images: [image()] });
      const currentRevision = threadComposerRevision(inputDraft);
      const result = await submitThreadTurn({
        draft: inputDraft,
        target: target({
          isLocalDraftThread: true,
          isServerThread: false,
          isFirstMessage: true,
          prepareWorkspace: true,
          workspaceProfile: "minimal",
          ...(workspaceKind ? { workspaceKind } : {}),
          baseRevision: "main",
          startFromOrigin: true,
        }),
        title: "Ship it",
        delivery: createDirectThreadTurnDeliveryAdapter({
          dispatchCommand: async (command) => void delivered.push(command),
        }),
        composer: {
          clearOnSuccess: "if-current",
          readCurrentRevision: () => currentRevision,
          clear: () => undefined,
        },
        readAttachment: async () => "data:image/png;base64,AA==",
        makeCommandId: () => CommandId.make("command-1"),
        makeMessageId: () => MessageId.make("message-1"),
        now: () => "2026-08-09T10:00:00.000Z",
      });

      assert.equal(result.kind, "delivered");
      if (result.kind !== "delivered") return;
      assert.equal(result.prepared.command.type, "thread.turn.start");
      if (result.prepared.command.type !== "thread.turn.start") return;
      const attachment = result.prepared.command.message.attachments[0];
      assert.ok(attachment && "dataUrl" in attachment);
      if (!attachment || !("dataUrl" in attachment)) return;
      assert.equal(attachment.dataUrl, "data:image/png;base64,AA==");
      assert.equal(result.prepared.command.bootstrap?.createThread?.projectId, projectId);
      assert.equal(
        result.prepared.command.bootstrap?.prepareWorkspace?.roots[0]?.baseRevision,
        "main",
      );
      assert.equal(
        result.prepared.command.bootstrap?.prepareWorkspace?.roots[0]?.startFromOrigin,
        true,
      );
      assert.equal(result.prepared.command.bootstrap?.prepareWorkspace?.profile, "minimal");
      assert.equal(
        result.prepared.command.bootstrap?.prepareWorkspace?.kind,
        workspaceKind ?? "auto",
      );
      assert.equal(delivered.length, 1);
    },
  );

  it("preserves a newer composer revision after durable delivery", async () => {
    const inputDraft = draft();
    let cleared = false;
    await submitThreadTurn({
      draft: inputDraft,
      target: target({ queue: true }),
      title: "Ship it",
      delivery: createDurableThreadTurnDeliveryAdapter({ enqueue: async () => undefined }),
      composer: {
        clearOnSuccess: "if-current",
        readCurrentRevision: () => ({ ...emptyRevision(), prompt: "new text" }),
        clear: () => void (cleared = true),
      },
      makeCommandId: () => CommandId.make("command-1"),
      makeMessageId: () => MessageId.make("message-1"),
      now: () => "2026-08-09T10:00:00.000Z",
    });

    assert.isFalse(cleared);
  });

  it("keeps queued messages out of the transcript until dispatch", async () => {
    const optimisticPhases: string[] = [];
    await submitThreadTurn({
      draft: draft(),
      target: target({ queue: true }),
      title: "Ship it",
      delivery: createDurableThreadTurnDeliveryAdapter({ enqueue: async () => undefined }),
      composer: {
        clearOnSuccess: "if-current",
        readCurrentRevision: emptyRevision,
        clear: () => undefined,
      },
      lifecycle: {
        addOptimistic: (_message, phase) => optimisticPhases.push(phase),
      },
      makeCommandId: () => CommandId.make("command-1"),
      makeMessageId: () => MessageId.make("message-1"),
      now: () => "2026-08-09T10:00:00.000Z",
    });

    assert.deepStrictEqual(optimisticPhases, []);
  });

  it("restores an emptied composer and removes its optimistic row after delivery failure", async () => {
    const events: string[] = [];
    let restored: ThreadTurnDraft | null = null;
    const inputDraft = draft({ images: [image()] });
    const result = await submitThreadTurn({
      draft: inputDraft,
      target: target(),
      title: "Ship it",
      delivery: createDurableThreadTurnDeliveryAdapter({
        enqueue: async () => {
          throw new Error("offline");
        },
      }),
      composer: {
        clearOnSuccess: "if-current",
        readCurrentRevision: emptyRevision,
        clear: () => undefined,
        restore: (nextDraft) => void (restored = nextDraft),
      },
      lifecycle: {
        addOptimistic: (_message, phase) => events.push(`optimistic:${phase}`),
        removeOptimistic: (messageId) => events.push(`remove:${messageId}`),
        failed: (error) => events.push(`failed:${error instanceof Error ? error.message : error}`),
        settled: (succeeded) => events.push(`settled:${succeeded}`),
      },
      readAttachment: async () => "data:image/png;base64,AA==",
      makeCommandId: () => CommandId.make("command-1"),
      makeMessageId: () => MessageId.make("message-1"),
      now: () => "2026-08-09T10:00:00.000Z",
    });

    assert.equal(result.kind, "failed");
    assert.ok(restored);
    assert.equal((restored as ThreadTurnDraft).prompt, "Ship it");
    assert.deepStrictEqual(events, [
      "optimistic:prepared",
      "remove:message-1",
      "failed:offline",
      "settled:false",
    ]);
  });
});
