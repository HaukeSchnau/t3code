import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, HtmlRenderPage, HtmlRenderPageFilter } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { htmlRenderEnvironment } from "../../state/htmlRender";
import { useEnvironmentQuery } from "../../state/query";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { HtmlRenderPageRow } from "./HtmlRenderPageRow";
import { htmlRenderPageRoute } from "./threadPages";

const PAGE_SIZE = 50;

const FILTERS = [
  { value: "asks", label: msg("Waiting for you", { $context: "tab, pages that ask for input" }) },
  { value: "unseen", label: msg("New", { $context: "tab, pages not seen yet" }) },
  { value: "all", label: msg("All", { $context: "tab, all pages" }) },
] as const satisfies ReadonlyArray<{ value: HtmlRenderPageFilter; label: string }>;

const EMPTY = {
  asks: {
    title: msg("Nothing is waiting for you"),
    detail: msg("Pages that ask for your input show up here."),
  },
  unseen: {
    title: msg("No new pages"),
    detail: msg("You have seen every page agents showed you."),
  },
  all: {
    title: msg("No pages yet"),
    detail: msg("Pages agents show you in threads collect here, newest first."),
  },
} as const satisfies Record<HtmlRenderPageFilter, { title: string; detail: string }>;

interface PageActions {
  readonly onOpen: (environmentId: EnvironmentId, page: HtmlRenderPage) => void;
  readonly onOpenThread: (environmentId: EnvironmentId, page: HtmlRenderPage) => void;
}

/** Pages from every connected environment, newest first. */
export function PagesScreen() {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const openDetail = useOpenWorkspaceDetail();
  const environments = useWorkspaceEnvironments().filter(
    (environment) => environment.connectionState === "connected",
  );
  const [filter, setFilter] = useState<HtmlRenderPageFilter>("all");
  const actions: PageActions = {
    onOpen: (environmentId, page) =>
      navigation.navigate("ThreadAttachment", htmlRenderPageRoute(environmentId, page)),
    onOpenThread: (environmentId, page) =>
      openDetail({
        name: "Thread",
        params: { environmentId: String(environmentId), threadId: String(page.threadId) },
      }),
  };

  return (
    <SettingsScreen title={gt("Pages")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SegmentedControl
          options={FILTERS.map((option) => ({ ...option, label: m(option.label) }))}
          selected={filter}
          onSelect={setFilter}
          role="tab"
          size="compact"
        />
        {environments.length === 0 ? (
          <EmptyState
            variant="plain"
            title={gt("No environment connected")}
            detail={gt("Connect to an environment to see the pages its agents showed you.")}
          />
        ) : (
          environments.map((environment) => (
            <EnvironmentPages
              // A new filter starts again from its first page of results.
              key={`${environment.environmentId}:${filter}`}
              environmentId={environment.environmentId}
              title={environments.length > 1 ? environment.environmentLabel : null}
              filter={filter}
              actions={actions}
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function pagesAtom(environmentId: EnvironmentId, filter: HtmlRenderPageFilter, cursor?: string) {
  return htmlRenderEnvironment.pages({
    environmentId,
    input: { filter, limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
  });
}

function EnvironmentPages(props: {
  readonly environmentId: EnvironmentId;
  /** Set when several environments are listed. */
  readonly title: string | null;
  readonly filter: HtmlRenderPageFilter;
  readonly actions: PageActions;
}) {
  const gt = useGT();
  const m = useMessages();
  const query = useEnvironmentQuery(pagesAtom(props.environmentId, props.filter));
  const [morePages, setMorePages] = useState(0);
  const empty = EMPTY[props.filter];

  return (
    <View className="gap-3">
      {props.title !== null ? (
        <Text textRole="headline" className="px-2 font-t3-bold text-foreground">
          {props.title}
        </Text>
      ) : null}
      {query.data === null ? (
        <Text className="px-2 text-base text-foreground-muted">
          {query.error ?? gt("Loading pages…")}
        </Text>
      ) : query.data.pages.length === 0 ? (
        <EmptyState variant="plain" title={m(empty.title)} detail={m(empty.detail)} />
      ) : (
        <ListSection>
          <PageRows
            environmentId={props.environmentId}
            pages={query.data.pages}
            first
            actions={props.actions}
          />
          {query.data.nextCursor === null ? null : (
            <MorePages
              environmentId={props.environmentId}
              filter={props.filter}
              cursor={query.data.nextCursor}
              remaining={morePages}
              onLoadMore={() => setMorePages((count) => count + 1)}
              actions={props.actions}
            />
          )}
        </ListSection>
      )}
    </View>
  );
}

/**
 * The results after `cursor`: `remaining` more pages of them, then Load more. Each page of results
 * starts after the one before it as that one stands now, so a page published meanwhile shifts
 * the rows down instead of dropping one between them.
 */
function MorePages(props: {
  readonly environmentId: EnvironmentId;
  readonly filter: HtmlRenderPageFilter;
  readonly cursor: string;
  readonly remaining: number;
  readonly onLoadMore: () => void;
  readonly actions: PageActions;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    props.remaining > 0 ? pagesAtom(props.environmentId, props.filter, props.cursor) : null,
  );
  if (props.remaining === 0) {
    return <LoadMoreRow label={gt("Load more")} onPress={props.onLoadMore} />;
  }
  if (query.data === null) {
    return query.error === null ? (
      <LoadMoreRow label={gt("Load more")} loading onPress={props.onLoadMore} />
    ) : (
      <LoadMoreRow label={gt("Could not load more pages. Try again")} onPress={query.refresh} />
    );
  }
  return (
    <>
      <PageRows
        environmentId={props.environmentId}
        pages={query.data.pages}
        actions={props.actions}
      />
      {query.data.nextCursor === null ? null : (
        <MorePages {...props} cursor={query.data.nextCursor} remaining={props.remaining - 1} />
      )}
    </>
  );
}

function LoadMoreRow(props: {
  readonly label: string;
  readonly loading?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <View className="border-t border-border-subtle">
      <ListActionRow label={props.label} loading={props.loading} onPress={props.onPress} />
    </View>
  );
}

function PageRows(props: {
  readonly environmentId: EnvironmentId;
  readonly pages: ReadonlyArray<HtmlRenderPage>;
  /** The first rows of their list, so the first one draws no divider above it. */
  readonly first?: boolean;
  readonly actions: PageActions;
}) {
  return props.pages.map((page, index) => (
    <View
      key={page.renderId}
      className={props.first && index === 0 ? undefined : "border-t border-border-subtle"}
    >
      <HtmlRenderPageRow
        page={page}
        onOpen={() => props.actions.onOpen(props.environmentId, page)}
        onOpenThread={() => props.actions.onOpenThread(props.environmentId, page)}
      />
    </View>
  ));
}
