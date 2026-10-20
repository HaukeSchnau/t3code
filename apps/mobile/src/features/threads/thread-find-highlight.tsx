import { splitThreadSearchText } from "@t3tools/shared/threadSearch";
import { Text as NativeText } from "react-native";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const FIND_MARK_COLORS = {
  light: "rgba(250, 204, 21, 0.4)",
  dark: "rgba(250, 204, 21, 0.3)",
} as const;

/**
 * Marks find matches inside a parent Text, which keeps its own font and color.
 * Rendered Markdown cannot carry marks, so only plain-text rows use this.
 */
export function ThreadFindText(props: { readonly text: string; readonly query: string | null }) {
  const { themeAppearance } = useAppearancePreferences();
  if (props.query === null || props.query.length === 0) return props.text;
  const parts = splitThreadSearchText(props.text, props.query);
  if (!parts.some((part) => part.highlighted)) return props.text;
  return parts.map((part) =>
    part.highlighted ? (
      <NativeText key={part.start} style={{ backgroundColor: FIND_MARK_COLORS[themeAppearance] }}>
        {part.text}
      </NativeText>
    ) : (
      part.text
    ),
  );
}
