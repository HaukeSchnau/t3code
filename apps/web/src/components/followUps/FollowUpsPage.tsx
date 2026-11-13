import { isFollowUpClosed } from "@t3tools/client-runtime/state/follow-ups";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FollowUp,
  FollowUpGardenerRun,
  FollowUpId,
  FollowUpType,
} from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ListTodoIcon, PlugZapIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useClientSettings } from "~/hooks/useSettings";
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
import { FollowUpDetail } from "./FollowUpDetail";
import { FollowUpGardenerStatus } from "./FollowUpGardenerStatus";
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
  readonly lastGardenerRun: FollowUpGardenerRun | null;
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
        lastGardenerRun: null,
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
      lastGardenerRun: snapshot?.lastGardenerRun ?? null,
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
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMinute = useNowMinute();
  const when = followUpWhenLabel(followUp, timestampFormat, Date.parse(`${nowMinute}:00.000Z`));
  const origin = followUp.origin?.threadTitle ?? null;
  return (
    <button
      type="button"
      aria-current={props.selected ? "true" : undefined}
      onClick={() => props.onSelect(followUp.id)}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{followUp.title}</span>
        {when !== null ? (
          <span className="max-w-48 shrink-0 truncate text-xs text-muted-foreground">{when}</span>
        ) : null}
      </span>
      {followUp.type !== null || followUp.tags.length > 0 || origin !== null ? (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
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
          {origin !== null ? <span className="min-w-0 truncate">from {origin}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

function storeNote(store: FollowUpStore): string | null {
  if (!store.connected) return `${store.label} is not connected, so its follow-ups are not shown.`;
  return store.error === null
    ? null
    : `Could not load follow-ups from ${store.label}: ${store.error}`;
}

/** The store's name when several show, its nightly pass, and why it shows nothing. */
function FollowUpStoreHeader(props: {
  readonly store: FollowUpStore;
  readonly showLabel: boolean;
}) {
  const { store } = props;
  const note = storeNote(store);
  const gardener = note === null && !store.loading;
  return (
    <>
      {props.showLabel || gardener ? (
        <div className="flex min-w-0 items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
          {props.showLabel ? (
            <>
              <h2 className="shrink-0">{store.label}</h2>
              <Separator className="min-w-2 flex-1" />
            </>
          ) : (
            <div className="flex-1" />
          )}
          {gardener ? (
            <FollowUpGardenerStatus
              homeEnvironmentId={store.environmentId}
              lastRun={store.lastGardenerRun}
            />
          ) : null}
        </div>
      ) : null}
      {note !== null ? (
        <p className="flex items-center gap-2 px-3 text-sm text-muted-foreground">
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
  const sections = followUpSections(store.followUps, props.showClosed);
  return (
    <section className="flex flex-col gap-3">
      <FollowUpStoreHeader store={store} showLabel={props.showLabel} />
      {storeNote(store) !== null ? null : store.loading ? (
        <div className="flex flex-col gap-2 px-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : sections.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground">
          Nothing to follow up on. Agents add follow-ups here as they work.
        </p>
      ) : (
        sections.map((section) => (
          <div key={section.key} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
              <h3 className="shrink-0">{section.label}</h3>
              <span className="shrink-0 tabular-nums text-muted-foreground/50">
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
        <EmptyTitle>No follow-up store connected</EmptyTitle>
        <EmptyDescription>
          None of the environments connected in this mode keeps follow-ups.
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
  const loadedStores = stores.filter((store) => !store.loading && storeNote(store) === null);
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
          <p className="p-5 text-sm text-muted-foreground">
            Nothing to follow up on. Agents add follow-ups here as they work.
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
          <EmptyTitle>Follow-up not found</EmptyTitle>
          <EmptyDescription>
            It may live in an environment that is not connected in this mode.
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
      <div className="@container/follow-ups flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <WorkspaceBreadcrumb ariaLabel="Follow-ups breadcrumb">
            <WorkspaceBreadcrumbItem current={!detailOpen}>
              {detailOpen ? (
                <Link
                  to="/follow-ups"
                  search={{
                    ...(showClosed ? { closed: true as const } : {}),
                    ...(graph ? { view: "graph" as const } : {}),
                  }}
                >
                  <WorkspaceBreadcrumbText>Follow-ups</WorkspaceBreadcrumbText>
                </Link>
              ) : (
                <h1 className="truncate">Follow-ups</h1>
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
              aria-label="Follow-ups view"
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
              <Toggle value="list">List</Toggle>
              <Toggle value="graph">Graph</Toggle>
            </ToggleGroup>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground [-webkit-app-region:no-drag]">
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
            Show closed
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
              <div className="min-w-0 flex-1 overflow-y-auto @4xl/follow-ups:w-120 @4xl/follow-ups:flex-none @4xl/follow-ups:border-l @4xl/follow-ups:border-border">
                <WorkspacePageContainer>{detailBody}</WorkspacePageContainer>
              </div>
            ) : null}
          </div>
        ) : detailOpen ? (
          <div className="flex min-h-0 flex-1">
            <div className="hidden w-88 shrink-0 overflow-y-auto border-r border-border px-2 pt-4 pb-12 @4xl/follow-ups:block">
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
