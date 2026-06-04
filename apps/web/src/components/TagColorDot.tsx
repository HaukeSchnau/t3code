import { TAG_COLOR_DOT_CLASSES, type UiTagColor } from "../tagColors";
import { cn } from "~/lib/utils";

export function TagColorDot({ color, className }: { color: UiTagColor; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        TAG_COLOR_DOT_CLASSES[color],
        className,
      )}
    />
  );
}
