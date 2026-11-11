import { useCallback, useLayoutEffect, useRef } from "react";
import type { SearchBarCommands } from "react-native-screens";

import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { getConnectionAwareBrandHeaderOptions } from "./brand-header-options";
import { createWorkspaceListHeaderItems } from "./workspace-list-header-items";
import {
  workspaceListFilterIcon,
  type WorkspaceListHeaderProps,
} from "./WorkspaceListHeader.types";

export function WorkspaceListHeader(props: WorkspaceListHeaderProps) {
  return props.sidebar ? <SidebarColumnHeader {...props} sidebar={props.sidebar} /> : null;
}

function SidebarColumnHeader(
  props: WorkspaceListHeaderProps & {
    readonly sidebar: NonNullable<WorkspaceListHeaderProps["sidebar"]>;
  },
) {
  const { search, sidebar } = props;
  const searchBarRef = useRef<SearchBarCommands>(null);
  // Registered once: the newest handler takes Cmd+F first, and re-registering on
  // every sidebar toggle would take it from an open thread's find.
  const latestSidebar = useRef(sidebar);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the once-registered handler's sidebar current; refs must not be written during render.
  useLayoutEffect(() => {
    latestSidebar.current = sidebar;
  });
  const focusSearch = useCallback(() => {
    const focus = () => searchBarRef.current?.focus();
    if (!latestSidebar.current.visible) {
      latestSidebar.current.onRequestVisibility();
      // Focus once the revealed sidebar has slid in.
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const items = createWorkspaceListHeaderItems({
    filter: {
      accessibilityLabel: "Filter threads",
      icon: workspaceListFilterIcon(props.filter.customized),
      title: "Thread list options",
      items: props.filter.items,
    },
    onOpenSettings: props.onOpenSettings,
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={[items, sidebar.width]}
      options={{
        ...getConnectionAwareBrandHeaderOptions({
          headerWidth: sidebar.width,
          trailingItemCount: items.length,
          onOpenEnvironments: props.onOpenEnvironments,
          fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
        }),
        headerSearchBarOptions: {
          ref: searchBarRef,
          autoCapitalize: "none",
          hideNavigationBar: false,
          hideWhenScrolling: false,
          obscureBackground: false,
          placeholder: search.placeholder,
          placement: "stacked",
          onCancelButtonPress: () => search.onChangeText(""),
          onChangeText: (event) => search.onChangeText(event.nativeEvent.text),
        },
        unstable_headerRightItems: () => items,
      }}
    />
  );
}
