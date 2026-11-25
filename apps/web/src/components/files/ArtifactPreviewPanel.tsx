import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isPublishedMarkdownUrl } from "@t3tools/shared/markdownLinks";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import ChatMarkdown from "~/components/ChatMarkdown";
import { artifactMarkdown } from "~/state/projects";
import { ChevronRightIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useGT } from "gt-react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { artifactReloadUrl } from "~/lib/artifactLink";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
} from "./fileSurfaceChrome";

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
  onReload,
}: {
  url: string;
  documentUrl: string;
  threadRef: ScopedThreadRef;
  onReload: () => void;
}) {
  const gt = useGT();
  const result = useAtomValue(
    artifactMarkdown({ environmentId: threadRef.environmentId, input: { url } }),
  );
  if (result._tag === "Failure") {
    const error = Cause.squash(result.cause);
    return (
      <FileSurfaceFailure
        message={error instanceof Error ? error.message : gt("Could not load Markdown.")}
        onRetry={onReload}
      />
    );
  }
  const value = AsyncResult.value(result);
  if (value._tag === "None") return <FileSurfaceLoading />;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ChatMarkdown
        text={value.value.contents}
        cwd={undefined}
        threadRef={threadRef}
        documentUrl={documentUrl}
        className="mx-auto max-w-4xl px-6 py-5"
      />
    </ScrollArea>
  );
}

/** Shows a published document beside its conversation. */
export default function ArtifactPreviewPanel(props: ArtifactPreviewPanelProps) {
  const gt = useGT();
  const [reloadRevision, setReloadRevision] = useState<number | null>(null);
  const pdf = isPdfUrl(props.url);
  const src = reloadRevision === null ? props.url : artifactReloadUrl(props.url, reloadRevision);
  const reload = () => setReloadRevision(Date.now());
  const openExternallyLabel = gt("Open artifact externally");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-artifact-preview>
      <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
        <Tooltip>
          <TooltipTrigger render={<div className="flex min-w-0 flex-1 items-center text-meta" />}>
            <span className="shrink-0 px-0.5 text-muted-foreground">{new URL(props.url).host}</span>
            <ChevronRightIcon aria-hidden className="mx-1 size-3.5 shrink-0 text-dim-foreground" />
            <span aria-current="page" className="min-w-0 truncate px-0.5 text-foreground">
              {props.title}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-sm break-all">
            {props.url}
          </TooltipPopup>
        </Tooltip>
        <FileSurfaceAction label={gt("Reload artifact")} onPress={reload}>
          <RefreshCwIcon className="size-3.5" />
        </FileSurfaceAction>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={openExternallyLabel}
                className="shrink-0"
                render={<a href={props.url} rel="noopener noreferrer" target="_blank" />}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <ExternalLinkIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{openExternallyLabel}</TooltipPopup>
        </Tooltip>
      </div>
      {isPublishedMarkdownUrl(props.url) && props.threadRef ? (
        <PublishedMarkdown
          key={src}
          url={src}
          documentUrl={props.url}
          threadRef={props.threadRef}
          onReload={reload}
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
