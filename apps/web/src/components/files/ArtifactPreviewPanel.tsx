import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isPublishedMarkdownUrl } from "@t3tools/shared/markdownLinks";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import ChatMarkdown from "~/components/ChatMarkdown";
import { artifactMarkdown } from "~/state/projects";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { artifactReloadUrl } from "~/lib/artifactLink";

interface ArtifactPreviewPanelProps {
  readonly threadRef: ScopedThreadRef | null;
  readonly url: string;
  readonly title: string;
}

function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function PublishedMarkdown({
  url,
  documentUrl,
  threadRef,
}: {
  url: string;
  documentUrl: string;
  threadRef: ScopedThreadRef;
}) {
  const result = useAtomValue(
    artifactMarkdown({ environmentId: threadRef.environmentId, input: { url } }),
  );
  if (result._tag === "Failure") {
    const error = Cause.squash(result.cause);
    return (
      <div role="alert" className="p-6 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "Could not load Markdown."} Reload or open
        externally.
      </div>
    );
  }
  const value = AsyncResult.value(result);
  if (value._tag === "None") {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Loading Markdown…
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ChatMarkdown
        text={value.value.contents}
        cwd={undefined}
        threadRef={threadRef}
        documentUrl={documentUrl}
        className="mx-auto max-w-4xl px-6 py-5"
      />
    </div>
  );
}

/** Shows a published document beside its conversation. */
export default function ArtifactPreviewPanel(props: ArtifactPreviewPanelProps) {
  const [reloadRevision, setReloadRevision] = useState<number | null>(null);
  const pdf = isPdfUrl(props.url);
  const src = reloadRevision === null ? props.url : artifactReloadUrl(props.url, reloadRevision);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-artifact-preview>
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <Tooltip>
          <TooltipTrigger render={<div className="min-w-0 flex-1 leading-tight" />}>
            <div className="truncate text-xs font-medium text-foreground">{props.title}</div>
            <div className="truncate text-[10px] text-muted-foreground">{props.url}</div>
          </TooltipTrigger>
          <TooltipPopup className="max-w-sm break-all">{props.url}</TooltipPopup>
        </Tooltip>
        <Button
          aria-label="Reload artifact"
          onClick={() => setReloadRevision(Date.now())}
          size="compact"
          variant="ghost-muted"
        >
          <RefreshCwIcon aria-hidden className="size-3" />
          Reload
        </Button>
        <Button
          aria-label="Open artifact externally"
          render={<a href={props.url} rel="noopener noreferrer" target="_blank" />}
          size="compact"
          variant="ghost-muted"
        >
          <ExternalLinkIcon aria-hidden className="size-3" />
          Open externally
        </Button>
      </div>
      {isPublishedMarkdownUrl(props.url) && props.threadRef ? (
        <PublishedMarkdown
          key={src}
          url={src}
          documentUrl={props.url}
          threadRef={props.threadRef}
        />
      ) : (
        /* The validated external origin needs module, fetch, and storage access. PDFs use the browser viewer. */
        <iframe
          key={src}
          src={src}
          title={props.title}
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox={
            pdf
              ? undefined
              : "allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin"
          }
        />
      )}
    </div>
  );
}
