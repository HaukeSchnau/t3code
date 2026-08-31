/**
 * The two marks every orchestration surface shares: a state dot and a toned
 * badge. Both take a `StatePresentation` rather than a state, so the roster,
 * the graph node and the comparison header cannot pick different words or
 * different colours for the same condition.
 */
import { cn } from "../../lib/utils";
import type { StatePresentation } from "../../orchestration/presentation";
import { toneBadgeVariant, toneDotClass } from "../../orchestration/presentation";
import { Badge } from "../ui/badge";

export function StateDot({
  presentation,
  className,
}: {
  readonly presentation: StatePresentation;
  readonly className?: string;
}) {
  return (
    <span
      // The label is on the dot itself: on a roster row the dot is often the
      // only state marker a screen reader would otherwise reach.
      aria-label={presentation.label}
      role="img"
      className={cn("size-2 shrink-0 rounded-full", toneDotClass(presentation.tone), className)}
    />
  );
}

export function ToneBadge({
  presentation,
  size = "sm",
  className,
}: {
  readonly presentation: StatePresentation;
  readonly size?: "sm" | "default";
  readonly className?: string;
}) {
  return (
    <Badge className={className} size={size} variant={toneBadgeVariant(presentation.tone)}>
      {presentation.label}
    </Badge>
  );
}
