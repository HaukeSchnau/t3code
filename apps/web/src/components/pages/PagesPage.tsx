import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  HtmlRenderPage,
  HtmlRenderPageFilter,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AppWindowIcon } from "lucide-react";
import { useState } from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react";

import { isElectron } from "~/env";
import { newMessageId } from "~/lib/utils";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";
import { htmlRenderEnvironment } from "~/state/htmlRender";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "~/types";

import { HtmlRenderPageDialog } from "../chat/HtmlRenderPageDialog";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Separator } from "../ui/separator";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PageListRow } from "./PageListRow";

export interface PagesSearch {
  readonly filter?: Exclude<HtmlRenderPageFilter, "all">;
}

const FILTERS = [
  { value: "all", label: msg("All", { $context: "filter, every page" }) },
  { value: "asks", label: msg("Waiting for you") },
  { value: "unseen", label: msg("New", { $context: "filter, pages not seen yet" }) },
] as const satisfies ReadonlyArray<{ value: HtmlRenderPageFilter; label: string }>;

const PAGE_SIZE = 50;

const EMPTY: Record<HtmlRenderPageFilter, string> = {
  all: "Pages agents show in threads collect here.",
  asks: "No page is waiting for you.",
  unseen: "You have seen every page.",
};

interface OpenPage {
  readonly environmentId: EnvironmentId;
  readonly page: HtmlRenderPage;
}

/** Every page agents showed, newest first, across the connected environments. */
export function PagesPage() {
  const gt = useGT();
  const m = useMessages();
  const search = useSearch({ from: "/_chat/pages" });
  const navigate = useNavigate({ from: "/pages" });
  const filter: HtmlRenderPageFilter = search.filter ?? "all";
  const connected = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const [opened, setOpened] = useState<OpenPage | null>(null);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const label = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;

  // A page answers its thread as if the reader typed in it, even one this client has not loaded.
  const sendToThread =
    (target: OpenPage) => async (text: string, context: OrchestrationMessageContext) => {
      const result = await startTurn({
        environmentId: target.environmentId,
        input: {
          threadId: target.page.threadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [], context },
          // A message to an existing thread runs with the thread's own modes; only a launch reads these.
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          dispatchMode: "queue",
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        throw error instanceof Error ? error : new Error("Could not send the page's message.");
      }
    };
  const openThread = (environmentId: EnvironmentId, page: HtmlRenderPage) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, page.threadId)),
    });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel={gt("Pages breadcrumb")}>
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">
                <T>Pages</T>
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <div className="shrink-0 [-webkit-app-region:no-drag]">
            <ToggleGroup
              aria-label={gt("Show pages")}
              size="segmented"
              variant="segmented"
              value={[filter]}
              onValueChange={(next) => {
                const value = next[0];
                if (value !== "all" && value !== "asks" && value !== "unseen") return;
                void navigate({ search: value === "all" ? {} : { filter: value } });
              }}
            >
              {FILTERS.map((option) => (
                <Toggle key={option.value} value={option.value}>
                  {m(option.label)}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer>
            {connected.length === 0 ? (
              <Empty size="compact">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <AppWindowIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    <T>No environment connected</T>
                  </EmptyTitle>
                  <EmptyDescription>
                    <T>Connect an environment to see its pages.</T>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-6">
                {connected.map((environmentId) => (
                  <PagesEnvironmentSection
                    // A new filter starts again from the newest page.
                    key={`${environmentId}:${filter}`}
                    environmentId={environmentId}
                    label={connected.length > 1 ? label(environmentId) : null}
                    filter={filter}
                    onOpen={(page) => setOpened({ environmentId, page })}
                    onOpenThread={(page) => openThread(environmentId, page)}
                  />
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
      {opened !== null ? (
        <HtmlRenderPageDialog
          environmentId={opened.environmentId}
          threadRef={scopeThreadRef(opened.environmentId, opened.page.threadId)}
          page={opened.page}
          onSendMessage={sendToThread(opened)}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </SidebarInset>
  );
}

export function PagesEnvironmentSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly filter: HtmlRenderPageFilter;
  readonly onOpen: (page: HtmlRenderPage) => void;
  readonly onOpenThread: (page: HtmlRenderPage) => void;
}) {
  const [morePages, setMorePages] = useState(0);
  return (
    <section className="flex flex-col gap-1">
      {props.label !== null ? (
        <div className="flex min-w-0 items-center gap-2 px-3 pb-1 text-meta text-muted-foreground">
          <h2 className="shrink-0">{props.label}</h2>
          <Separator className="min-w-2 flex-1" />
        </div>
      ) : null}
      <PagesChunk
        environmentId={props.environmentId}
        filter={props.filter}
        cursor={undefined}
        remaining={morePages}
        onOpen={props.onOpen}
        onOpenThread={props.onOpenThread}
        onMore={() => setMorePages((count) => count + 1)}
      />
    </section>
  );
}

/**
 * One page of results, then `remaining` more, then Load more. Each starts after the one before
 * it as that one stands now, so a page published or gone meanwhile shifts the rows instead of
 * dropping or repeating one between them.
 */
function PagesChunk(props: {
  readonly environmentId: EnvironmentId;
  readonly filter: HtmlRenderPageFilter;
  readonly cursor: string | undefined;
  readonly remaining: number;
  readonly onOpen: (page: HtmlRenderPage) => void;
  readonly onOpenThread: (page: HtmlRenderPage) => void;
  readonly onMore: () => void;
}) {
  const query = useEnvironmentQuery(
    htmlRenderEnvironment.pages({
      environmentId: props.environmentId,
      input: {
        filter: props.filter,
        limit: PAGE_SIZE,
        ...(props.cursor === undefined ? {} : { cursor: props.cursor }),
      },
    }),
  );
  if (query.data === null) {
    return query.error !== null ? (
      <p className="px-3 text-body text-muted-foreground">
        <T>
          Could not load pages: <Var>{query.error}</Var>
        </T>
      </p>
    ) : (
      <div className="flex flex-col gap-2 px-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  const { pages, nextCursor } = query.data;
  if (props.cursor === undefined && pages.length === 0) {
    return <p className="px-3 text-body text-muted-foreground">{EMPTY[props.filter]}</p>;
  }
  return (
    <>
      {pages.map((page) => (
        <PageListRow
          key={page.renderId}
          page={page}
          showThread
          onOpen={props.onOpen}
          onOpenThread={props.onOpenThread}
        />
      ))}
      {nextCursor === null ? null : props.remaining > 0 ? (
        <PagesChunk {...props} cursor={nextCursor} remaining={props.remaining - 1} />
      ) : (
        <div className="px-3 pt-2">
          <Button size="standard" variant="secondary" onClick={props.onMore}>
            <T>Load more</T>
          </Button>
        </div>
      )}
    </>
  );
}
