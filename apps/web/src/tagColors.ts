export const TAG_COLOR_VALUES = [
  "gray",
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "pink",
  "cyan",
] as const;

export type UiTagColor = (typeof TAG_COLOR_VALUES)[number];

export const DEFAULT_TAG_COLOR: UiTagColor = "gray";

export const TAG_COLOR_LABELS: Record<UiTagColor, string> = {
  amber: "Amber",
  blue: "Blue",
  cyan: "Cyan",
  gray: "Gray",
  green: "Green",
  pink: "Pink",
  purple: "Purple",
  red: "Red",
};

export const TAG_COLOR_DOT_CLASSES: Record<UiTagColor, string> = {
  amber: "bg-amber-500 dark:bg-amber-400",
  blue: "bg-blue-500 dark:bg-blue-400",
  cyan: "bg-cyan-500 dark:bg-cyan-400",
  gray: "bg-muted-foreground/55",
  green: "bg-emerald-500 dark:bg-emerald-400",
  pink: "bg-pink-500 dark:bg-pink-400",
  purple: "bg-violet-500 dark:bg-violet-400",
  red: "bg-red-500 dark:bg-red-400",
};

export function sanitizeTagColor(value: unknown): UiTagColor | null {
  return typeof value === "string" && TAG_COLOR_VALUES.includes(value as UiTagColor)
    ? (value as UiTagColor)
    : null;
}

export function tagColorFromId(tagId: string): UiTagColor {
  let hash = 0;
  for (let index = 0; index < tagId.length; index += 1) {
    hash = (hash * 31 + tagId.charCodeAt(index)) >>> 0;
  }
  return TAG_COLOR_VALUES[hash % TAG_COLOR_VALUES.length] ?? DEFAULT_TAG_COLOR;
}
