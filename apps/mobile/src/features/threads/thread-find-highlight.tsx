import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { Text as NativeText } from "react-native";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const FIND_MARK_COLORS = {
  light: "rgba(250, 204, 21, 0.4)",
  dark: "rgba(250, 204, 21, 0.3)",
} as const;

interface ThreadFindTextPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

function splitThreadFindText(text: string, query: string): ThreadFindTextPart[] {
  const parts: ThreadFindTextPart[] = [];
  let cursor = 0;
  for (const offset of findThreadSearchOccurrences(text, query)) {
    if (offset > cursor) {
      parts.push({ text: text.slice(cursor, offset), highlighted: false, start: cursor });
    }
    parts.push({
      text: text.slice(offset, offset + query.length),
      highlighted: true,
      start: offset,
    });
    cursor = offset + query.length;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }
  return parts;
}

/**
 * Marks find matches inside a parent Text, which keeps its own font and color.
 * Rendered Markdown cannot carry marks, so only plain-text rows use this.
 */
export function ThreadFindText(props: { readonly text: string; readonly query: string | null }) {
  const { themeAppearance } = useAppearancePreferences();
  const query = props.query?.trim() ?? "";
  if (query.length === 0) return props.text;
  const parts = splitThreadFindText(props.text, query);
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
