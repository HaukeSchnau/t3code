import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { serializeComposerMessageForServer } from "./composerContext";

import {
  buildProjectThreadStartTurnInput,
  type ProjectThreadStartTurnSpec,
} from "./projectThreadStartTurn";

describe("project thread title", () => {
  it.each([
    {
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      text: "![photo.png](t3-context://v1/image/photo)",
      title: "Attached image",
    },
    {
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "",
      title: "File: report.pdf",
    },
    {
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "[report.pdf](t3-context://v1/file/report)",
      title: "report.pdf",
    },
  ])("titles a $type-only message without changing its data", ({ text, title, ...attachment }) => {
    const uploadedAttachments = [{ ...attachment, id: "prepared-attachment", sizeBytes: 3 }];
    const wire = serializeComposerMessageForServer(text, undefined, true);
    const spec = {
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "image-thread",
      commandId: "image-command",
      messageId: "image-message",
      createdAt: "2026-09-04T00:00:00Z",
      ...wire,
      titleText: text,
      uploadedAttachments,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    } satisfies ProjectThreadStartTurnSpec;
    const input = buildProjectThreadStartTurnInput(spec);

    expect(input.titleSeed).toBe(title);
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.attachments).toEqual(uploadedAttachments);
    expect(input.message.text).toBe(wire.text);
    const relaunched = buildProjectThreadStartTurnInput({
      ...spec,
      threadId: "local-relaunch",
      text: input.message.text,
      titleText: input.bootstrap.createThread.title,
    });
    expect(relaunched.titleSeed).toBe(title);
    expect(relaunched.message.text).toBe(wire.text);
    expect(relaunched.message.attachments).toEqual(uploadedAttachments);
  });
});

// Fork: managed workspaces (patches/workspaces.md).
describe("managed workspace bootstrap", () => {
  it("asks the server for a new workspace without requiring a branch", () => {
    const spec = {
      projectId: ProjectId.make("project"),
      projectCwd: "/notes",
      threadId: "workspace-thread",
      commandId: "workspace-command",
      messageId: "workspace-message",
      createdAt: "2026-10-05T00:00:00Z",
      text: "Draft the release notes",
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      workspaceMode: "worktree" as const,
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "t3code/0a1b2c3d",
    };
    const input = buildProjectThreadStartTurnInput({
      ...spec,
      managedWorkspace: { profile: "minimal" },
    });
    expect(input.bootstrap).toMatchObject({
      prepareWorkspace: { profile: "minimal" },
      runSetupScript: true,
    });
    expect(input.bootstrap).not.toHaveProperty("prepareWorktree");
    expect(buildProjectThreadStartTurnInput({ ...spec, branch: "main" }).bootstrap).toMatchObject({
      prepareWorktree: { baseBranch: "main", branch: "t3code/0a1b2c3d" },
    });
  });
});
