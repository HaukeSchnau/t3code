import { assert, describe, expect, it, vi } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";

import {
  editableTextFromUserMessage,
  hydrateMessageImagesForEdit,
  runPreviousMessageEditTransaction,
} from "./previousMessageEditing";

describe("previous message editing", () => {
  it("removes the injected effort prefix from editable text", () => {
    assert.equal(editableTextFromUserMessage(" Ultrathink:\nFix this "), "Fix this");
    assert.equal(editableTextFromUserMessage("Keep this"), "Keep this");
  });

  it("does not restore the composer when pruning fails", async () => {
    const events: string[] = [];
    const result = await runPreviousMessageEditTransaction({
      pruneHistory: async () => {
        events.push("prune");
        throw new Error("prune failed");
      },
      waitForPrunedHistory: async () => void events.push("wait"),
      submitReplacement: async () => void events.push("submit"),
      onHistoryPruned: () => events.push("pruned"),
      onReplacementFailed: () => events.push("restore"),
    });

    assert.deepStrictEqual(result, {
      kind: "failed",
      stage: "prune",
      error: new Error("prune failed"),
    });
    assert.deepStrictEqual(events, ["prune"]);
  });

  it("restores only after prune succeeds and replacement fails", async () => {
    const events: string[] = [];
    const result = await runPreviousMessageEditTransaction({
      pruneHistory: async () => void events.push("prune"),
      waitForPrunedHistory: async () => void events.push("wait"),
      submitReplacement: async () => {
        events.push("submit");
        throw new Error("start failed");
      },
      onHistoryPruned: () => events.push("pruned"),
      onReplacementFailed: () => events.push("restore"),
    });

    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.stage, "replacement");
    assert.deepStrictEqual(events, ["prune", "wait", "pruned", "submit", "restore"]);
  });

  it("releases hydrated attachment preview URLs when a later image fails", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:edit-preview");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(new Blob(["image"], { type: "image/png" })))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    await expect(
      hydrateMessageImagesForEdit({
        id: MessageId.make("message-1"),
        role: "user",
        text: "Images",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "first.png",
            mimeType: "image/png",
            sizeBytes: 5,
            previewUrl: "/first.png",
          },
          {
            type: "image",
            id: "attachment-2",
            name: "second.png",
            mimeType: "image/png",
            sizeBytes: 5,
            previewUrl: "/second.png",
          },
        ],
        turnId: null,
        createdAt: "2026-08-09T10:00:00.000Z",
        updatedAt: "2026-08-09T10:00:00.000Z",
        streaming: false,
      }),
    ).rejects.toThrow("Failed to load image attachment 'second.png'.");
    assert.equal(createObjectUrl.mock.calls.length, 1);
    assert.deepStrictEqual(revokeObjectUrl.mock.calls, [["blob:edit-preview"]]);
    fetchMock.mockRestore();
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
  });
});
