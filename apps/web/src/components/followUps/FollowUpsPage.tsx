import { isFollowUpClosed } from "@t3tools/client-runtime/state/follow-ups";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, FollowUp, FollowUpId, FollowUpType } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { ListTodoIcon, PlugZapIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useClientSettings } from "~/hooks/useSettings";
import type { MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { useEnvironments } from "~/state/environments";
import {
  allFollowUpSnapshotsAtom,
  followUpHomesAtom,
  openFollowUpSnapshotsAtom,
} from "~/state/followUps";
import { formatEnvironmentQueryError } from "~/state/query";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Separator } from "../ui/separator";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PULL_REQUEST_ROW_CLASS, PullRequestRowLines } from "../pullRequest/PullRequestListRow";
import {
  PAGE_ROW_CLASS,
  PAGE_ROW_HOVER_CLASS,
  PAGE_ROW_PRESS_CLASS,
} from "../pullRequest/PullRequestRow";
import { FollowUpDetail } from "./FollowUpDetail";
import { FollowUpGraphView } from "./FollowUpGraphView";
import { followUpGraphKey, followUpSections, followUpWhenLabel } from "./followUps.logic";

export interface FollowUpsSearch {
  /** The home environment that keeps `id`; a follow-up link names it. */
  readonly home?: string;
  readonly id?: string;
  readonly closed?: true;
  readonly view?: "graph";
}

interface FollowUpStore {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly followUps: ReadonlyArray<FollowUp>;
  readonly types: ReadonlyArray<FollowUpType>;
}

/**
 * The stores the active mode's environments use. Closed follow-ups load only when shown, or
 * when the linked one is not among the open ones.
 */
function useFollowUpStores(selectedId: string | undefined, showClosed: boolean) {
  const homes = useAtomValue(followUpHomesAtom);
  const { environments } = useEnvironments();
  const connectedIds = homes.flatMap((home) => (home.connected ? [home.environmentId] : []));
  const key = environmentIdsKey(connectedIds);
  const open = useAtomValue(openFollowUpSnapshotsAtom(key));
  const openSnapshots = open.map((result) => AsyncResult.getOrElse(result, () => null));
  const selectedIsOpen = openSnapshots.some((snapshot) =>
    snapshot?.followUps.some((followUp) => followUp.id === selectedId),
  );
  const openSettled = open.every((result) => result._tag !== "Initial");
  const wantClosed = showClosed || (selectedId !== undefined && openSettled && !selectedIsOpen);
  const all = useAtomValue(allFollowUpSnapshotsAtom(wantClosed ? key : ""));
  const stores = homes.map((home): FollowUpStore => {
    const label =
      environments.find((environment) => environment.environmentId === home.environmentId)?.label ??
      home.environmentId;
    const index = connectedIds.indexOf(home.environmentId);
    if (index < 0) {
      return {
        environmentId: home.environmentId,
        label,
        connected: false,
        loading: false,
        error: null,
        followUps: [],
        types: [],
      };
    }
    // While closed ones load, the open ones stay on screen.
    const result = wantClosed && all[index]?._tag === "Success" ? all[index] : open[index]!;
    const snapshot = AsyncResult.getOrElse(result, () => null);
    return {
      environmentId: home.environmentId,
      label,
      connected: true,
      loading: snapshot === null && result._tag !== "Failure",
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      followUps: snapshot?.followUps ?? [],
      types: snapshot?.types ?? [],
    };
  });
  return { stores, loadingClosed: wantClosed && all.some((result) => result._tag === "Initial") };
}

function FollowUpRow(props: {
  readonly followUp: FollowUp;
  readonly selected: boolean;
  readonly onSelect: (id: FollowUpId) => void;
}) {
  const { followUp } = props;
  const m = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMinute = useNowMinute();
  const when = followUpWhenLabel(followUp, timestampFormat, Date.parse(`${nowMinute}:00.000Z`), m);
  const origin = followUp.origin?.threadTitle ?? null;
  // The pull request and issue pages' row.
  return (
    <div
      className={cn(
        "flex items-center rounded-control",
        props.selected ? "bg-selection-subtle" : PAGE_ROW_HOVER_CLASS,
      )}
    >
      <button
        type="button"
        aria-current={props.selected ? "true" : undefined}
        onClick={() => props.onSelect(followUp.id)}
        className={cn(
          PULL_REQUEST_ROW_CLASS,
          PAGE_ROW_CLASS,
          PAGE_ROW_PRESS_CLASS,
          "min-w-0 flex-1",
        )}
      >
        <PullRequestRowLines
          layout="page"
          number={null}
          title={followUp.title}
          meta={
            <>
              {followUp.type !== null ? (
                <Badge variant="outline" size="sm">
                  {followUp.type}
                </Badge>
              ) : null}
              {followUp.tags.map((tag) => (
                <Badge key={tag} variant="secondary" size="sm">
                  {tag}
                </Badge>
              ))}
              {origin !== null ? (
                <span className="min-w-0 truncate">
                  <T>
                    from <Var>{origin}</Var>
                  </T>
                </span>
              ) : null}
            </>
          }
          metaStatus={
            when !== null ? <span className="min-w-0 truncate tabular-nums">{when}</span> : null
          }
        />
      </button>
    </div>
  );
}

function storeNote(store: FollowUpStore, resolve: MessageResolver): string | null {
  if (!store.connected) {
    return resolve(
      msg("{environment} is not connected, so its follow-ups are not shown.", {
        environment: store.label,
      }),
    );
  }
  return store.error === null
    ? null
    : resolve(
        msg("Could not load follow-ups from {environment}: {error}", {
          environment: store.label,
          error: store.error,
        }),
      );
}

/** The store's name when several show, and why it shows nothing. */
function FollowUpStoreHeader(props: {
  readonly store: FollowUpStore;
  readonly showLabel: boolean;
}) {
  const { store } = props;
  const m = useMessages();
  const note = storeNote(store, m);
  return (
    <>
      {props.showLabel ? (
        <div className="flex min-w-0 items-center gap-2 px-3 text-label text-foreground">
          <h2 className="shrink-0">{store.label}</h2>
          <Separator className="min-w-2 flex-1" />
        </div>
      ) : null}
      {note !== null ? (
        <p className="flex items-center gap-2 px-3 text-body text-muted-foreground">
          <PlugZapIcon aria-hidden className="size-4 shrink-0" />
          {note}
        </p>
      ) : null}
    </>
  );
}

function FollowUpStoreList(props: {
  readonly store: FollowUpStore;
  readonly showLabel: boolean;
  readonly showClosed: boolean;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: FollowUpId) => void;
}) {
  const { store } = props;
  const m = useMessages();
  const sections = followUpSections(store.followUps, props.showClosed, m);
  return (
    <section className="flex flex-col gap-3">
      <FollowUpStoreHeader store={store} showLabel={props.showLabel} />
      {storeNote(store, m) !== null ? null : store.loading ? (
        <div className="flex flex-col gap-2 px-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : sections.length === 0 ? (
        <p className="px-3 text-body text-muted-foreground">
          <T>Nothing to follow up on. Agents add follow-ups here as they work.</T>
        </p>
      ) : (
        sections.map((section) => (
          <div key={section.key} className="flex flex-col">
            <div className="flex h-7 items-center gap-2 px-3 text-meta text-muted-foreground">
              <h3 className="shrink-0">{section.label}</h3>
              <span className="shrink-0 tabular-nums text-dim-foreground">
                {section.followUps.length}
              </span>
              <Separator className="min-w-2 flex-1" />
            </div>
            {section.followUps.map((followUp) => (
              <FollowUpRow
                key={followUp.id}
                followUp={followUp}
                selected={followUp.id === props.selectedId}
                onSelect={props.onSelect}
              />
            ))}
          </div>
        ))
      )}
    </section>
  );
}

export function FollowUpsPage() {
  const gt = useGT();
  const m = useMessages();
  const search = useSearch({ from: "/_chat/follow-ups" });
  const navigate = useNavigate({ from: "/follow-ups" });
  const showClosed = search.closed === true;
  const { stores, loadingClosed } = useFollowUpStores(search.id, showClosed);
  const selected =
    search.id === undefined
      ? null
      : (stores.flatMap((store) => {
          if (search.home !== undefined && store.environmentId !== search.home) return [];
          const followUp = store.followUps.find((candidate) => candidate.id === search.id);
          return followUp ? [{ store, followUp }] : [];
        })[0] ?? null);
  const selectedMissing =
    search.id !== undefined &&
    selected === null &&
    !loadingClosed &&
    stores.every((store) => !store.loading);
  const select = (id: FollowUpId) =>
    void navigate({ search: ({ home: _home, ...previous }) => ({ ...previous, id }) });
  const graph = search.view === "graph";
  const noStores = (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ListTodoIcon />
        </EmptyMedia>
        <EmptyTitle>
          <T>No follow-up store connected</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>None of the environments connected in this mode keeps follow-ups.</T>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
  const listBody =
    stores.length === 0 ? (
      noStores
    ) : (
      <div className="flex flex-col gap-6">
        {stores.map((store) => (
          <FollowUpStoreList
            key={store.environmentId}
            store={store}
            showLabel={stores.length > 1}
            showClosed={showClosed}
            selectedId={search.id}
            onSelect={select}
          />
        ))}
      </div>
    );
  const loadedStores = stores.filter((store) => !store.loading && storeNote(store, m) === null);
  const graphHasNodes = loadedStores.some((store) =>
    store.followUps.some((followUp) => showClosed || !isFollowUpClosed(followUp)),
  );
  const graphBody =
    stores.length === 0 ? (
      <div className="p-6">{noStores}</div>
    ) : (
      <>
        <div className="flex shrink-0 flex-col gap-2 px-2 pt-3">
          {stores.map((store) => (
            <FollowUpStoreHeader
              key={store.environmentId}
              store={store}
              showLabel={stores.length > 1}
            />
          ))}
        </div>
        {graphHasNodes ? (
          <div className="min-h-0 flex-1">
            <FollowUpGraphView
              stores={loadedStores}
              showClosed={showClosed}
              selectedKey={
                selected === null
                  ? null
                  : followUpGraphKey(selected.store.environmentId, selected.followUp.id)
              }
              onSelectFollowUp={select}
            />
          </div>
        ) : stores.some((store) => store.loading) ? (
          <div className="flex flex-col gap-2 p-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <p className="p-5 text-body text-muted-foreground">
            <T>Nothing to follow up on. Agents add follow-ups here as they work.</T>
          </p>
        )}
      </>
    );
  const detailOpen = search.id !== undefined;
  const detailBody =
    selected !== null ? (
      <FollowUpDetail
        key={`${selected.store.environmentId}:${selected.followUp.id}`}
        homeEnvironmentId={selected.store.environmentId}
        followUp={selected.followUp}
        types={selected.store.types}
        titleOf={(id) =>
          selected.store.followUps.find((followUp) => followUp.id === id)?.title ?? null
        }
        onOpenFollowUp={select}
      />
    ) : selectedMissing ? (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>
            <T>Follow-up not found</T>
          </EmptyTitle>
          <EmptyDescription>
            <T>It may live in an environment that is not connected in this mode.</T>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="@container/follow-ups flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel={gt("Follow-ups breadcrumb")}>
            <WorkspaceBreadcrumbItem current={!detailOpen}>
              {detailOpen ? (
                <Link
                  to="/follow-ups"
                  search={{
                    ...(showClosed ? { closed: true as const } : {}),
                    ...(graph ? { view: "graph" as const } : {}),
                  }}
                >
                  <WorkspaceBreadcrumbText>
                    <T>Follow-ups</T>
                  </WorkspaceBreadcrumbText>
                </Link>
              ) : (
                <h1 className="truncate">
                  <T>Follow-ups</T>
                </h1>
              )}
            </WorkspaceBreadcrumbItem>
            {selected !== null ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>
                  <h1 className="truncate">{selected.followUp.title}</h1>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <div className="shrink-0 [-webkit-app-region:no-drag]">
            <ToggleGroup
              aria-label={gt("Follow-ups view")}
              size="segmented"
              variant="segmented"
              value={[graph ? "graph" : "list"]}
              onValueChange={(next) => {
                const view = next[0];
                if (view !== "list" && view !== "graph") return;
                void navigate({
                  search: (previous) => ({
                    ...(previous.home === undefined ? {} : { home: previous.home }),
                    ...(previous.id === undefined ? {} : { id: previous.id }),
                    ...(previous.closed ? { closed: true as const } : {}),
                    ...(view === "graph" ? { view: "graph" as const } : {}),
                  }),
                });
              }}
            >
              <Toggle value="list">
                <T context="follow-ups shown as a list">List</T>
              </Toggle>
              <Toggle value="graph">
                <T context="follow-ups shown as a graph">Graph</T>
              </Toggle>
            </ToggleGroup>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-body text-muted-foreground [-webkit-app-region:no-drag]">
            <Switch
              size="sm"
              checked={showClosed}
              onCheckedChange={(checked) =>
                void navigate({
                  search: (previous) => ({
                    ...(previous.home === undefined ? {} : { home: previous.home }),
                    ...(previous.id === undefined ? {} : { id: previous.id }),
                    ...(checked ? { closed: true as const } : {}),
                    ...(previous.view === undefined ? {} : { view: previous.view }),
                  }),
                })
              }
            />
            <T>Show closed</T>
          </label>
        </WorkspacePageHeader>
        {graph ? (
          <div className="flex min-h-0 flex-1">
            <div
              className={cn(
                "min-w-0 flex-1 flex-col",
                detailOpen ? "hidden @4xl/follow-ups:flex" : "flex",
              )}
            >
              {graphBody}
            </div>
            {detailOpen ? (
              <div className="min-w-0 flex-1 overflow-y-auto @4xl/follow-ups:w-120 @4xl/follow-ups:flex-none @4xl/follow-ups:border-l @4xl/follow-ups:border-divider">
                <WorkspacePageContainer>{detailBody}</WorkspacePageContainer>
              </div>
            ) : null}
          </div>
        ) : detailOpen ? (
          <div className="flex min-h-0 flex-1">
            <div className="hidden w-88 shrink-0 overflow-y-auto border-r border-divider px-2 pt-4 pb-12 @4xl/follow-ups:block">
              {listBody}
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto">
              <WorkspacePageContainer>{detailBody}</WorkspacePageContainer>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer>{listBody}</WorkspacePageContainer>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
