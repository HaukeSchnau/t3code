import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { formatReadToolLabel } from "@t3tools/shared/toolActivity";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { snapshotObservedImage } from "../../observedImageSnapshot.ts";
import type { CodexDynamicToolItem } from "./CodexAdapterV2.ts";

/**
 * Codex reports `view_image` as its own `imageView` item. T3 shows it like any
 * other tool call that read an image, so it reuses the dynamic tool projection.
 */
export function codexImageViewToolCall(item: {
  readonly id: string;
  readonly path: string;
}): CodexDynamicToolItem {
  return {
    type: "dynamicToolCall",
    id: item.id,
    tool: "view_image",
    arguments: { path: item.path },
    status: "completed",
  };
}

/** Points the item at the viewed image and attaches the server's copy of it. */
export const withObservedImage = (
  turnItem: OrchestrationV2TurnItem,
  input: {
    readonly path: string;
    readonly cwd: string | null;
    readonly agentExecState: string | undefined;
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
): Effect.Effect<OrchestrationV2TurnItem> =>
  Effect.gen(function* () {
    const path = input.path.trim();
    if (
      turnItem.type !== "dynamic_tool" ||
      path.length > 4096 ||
      /[\r\n]/.test(path) ||
      !isWorkspaceImagePreviewPath(path)
    ) {
      return turnItem;
    }
    const observedImage = yield* snapshotObservedImage({
      fileSystem: input.fileSystem,
      attachmentsDir: input.attachmentsDir,
      threadId: turnItem.threadId,
      path,
      cwd: input.cwd,
      agentExecState: input.agentExecState,
    });
    return {
      ...turnItem,
      title: formatReadToolLabel(path),
      viewedImagePath: path,
      ...(observedImage === undefined ? {} : { observedImage }),
    };
  });
