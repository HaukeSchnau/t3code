import type { UploadChatImageAttachment } from "@t3tools/contracts";

import type { DraftComposerImageAttachment } from "./composerImages";

/** Strip draft-only metadata before an attachment crosses the command boundary. */
export function toUploadChatImageAttachments(
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): ReadonlyArray<UploadChatImageAttachment> {
  return attachments.flatMap((attachment) =>
    attachment.dataUrl === undefined
      ? []
      : [
          {
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl: attachment.dataUrl,
          },
        ],
  );
}
