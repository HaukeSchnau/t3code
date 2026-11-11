import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { formatReadToolLabel } from "@t3tools/shared/toolActivity";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { snapshotObservedImage } from "../../observedImageSnapshot.ts";
/** Labels a Codex image view as a read and attaches the server's copy of the image. */
export const withObservedImage = Effect.fn("CodexImageView.withObservedImage")(function* (
  turnItem: OrchestrationV2TurnItem,
  input: {
    readonly path: string;
    readonly cwd: string | null;
    readonly agentExecState: string | undefined;
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
): Effect.fn.Return<OrchestrationV2TurnItem> {
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
    ...(observedImage === undefined ? {} : { observedImage }),
  };
});
