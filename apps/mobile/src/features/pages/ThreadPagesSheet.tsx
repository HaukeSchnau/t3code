import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { groupHtmlRenderPages } from "@t3tools/client-runtime/state/html-render";
import type { EnvironmentId, HtmlRenderPage, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { HtmlRenderPageRow } from "./HtmlRenderPageRow";
import { htmlRenderPageRoute, useThreadPages } from "./threadPages";

type PagesTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** A thread's pages: the ones waiting for the reader, the new ones, then the rest. */
export function ThreadPagesSheet({ route }: StaticScreenProps<PagesTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const query = useThreadPages(target);
  const groups = query.data === null ? null : groupHtmlRenderPages(query.data.pages);
  const sections = [
    { title: "Waiting for you", pages: groups?.asks ?? [] },
    { title: "New", pages: groups?.unseen ?? [] },
    { title: "Seen", pages: groups?.seen ?? [] },
  ].filter((section) => section.pages.length > 0);
  const open = (page: HtmlRenderPage) => {
    void Haptics.selectionAsync();
    // The page replaces this sheet, so Back from it returns to the thread.
    navigation.dispatch(
      StackActions.replace("ThreadAttachment", htmlRenderPageRoute(target.environmentId, page)),
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Pages" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-5 px-5 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {query.data === null ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              {query.error ?? "Loading pages…"}
            </Text>
          ) : sections.length === 0 ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              No pages in this thread yet.
            </Text>
          ) : (
            sections.map((section) => (
              <ListSection key={section.title} title={section.title}>
                {section.pages.map((page, index) => (
                  <View
                    key={page.renderId}
                    className={index === 0 ? undefined : "border-t border-border-subtle"}
                  >
                    <HtmlRenderPageRow page={page} onOpen={() => open(page)} />
                  </View>
                ))}
              </ListSection>
            ))
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
