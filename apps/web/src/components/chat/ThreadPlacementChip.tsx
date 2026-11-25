import type { ThreadPlacement } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

/** Where placement started the thread and why, with every machine it weighed. */
export function ThreadPlacementChip({ placement }: { placement: ThreadPlacement }) {
  const gt = useGT();
  return (
    <Popover>
      <PopoverTrigger nativeButton={false} render={<Badge variant="outline" size="sm" />}>
        {placement.label} · {placement.reason}
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <PopoverTitle>{gt("Placed on {machine}", { machine: placement.label })}</PopoverTitle>
        <p className="text-muted-foreground text-xs">
          {gt("{machine} chose it: {reason}.", {
            machine: placement.decidedBy.label,
            reason: placement.reason,
          })}
        </p>
        {placement.candidates.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {placement.candidates.map((candidate) => (
              <li key={candidate.environmentId} className="flex justify-between gap-3">
                <span className={candidate.admissible ? "" : "text-muted-foreground"}>
                  {candidate.label}
                  {candidate.note ? ` · ${candidate.note}` : ""}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {candidate.admissible
                    ? gt("{count} free", {
                        count: Math.floor(candidate.slots),
                        $context: "free agent slots on a machine",
                      })
                    : gt("no room", { $context: "a machine has no free agent slots" })}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
