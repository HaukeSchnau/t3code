import type { ProjectIconColor, ThreadWorldRepo } from "@t3tools/contracts";
import { worldRepoName, worldScopeKey } from "@t3tools/client-runtime/state/worlds";
import { useGT } from "gt-react";
import { MessageSquareDashedIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { projectIconColorClassName } from "../../projectIconColors";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { SidebarWorldLens } from "./SidebarWorlds.logic";

/**
 * The worlds as lenses over one inbox (patches/worlds.md): none pressed shows every world, and
 * pressing one shows only its threads, with old projects filed under it.
 */
export function SidebarWorldLenses(props: {
  readonly worlds: ReadonlyArray<SidebarWorldLens>;
  /** Threads outside every world that need the user, or null when no project is outside them. */
  readonly outsideNeedsYou: number | null;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
}) {
  const gt = useGT();
  const looseKey = worldScopeKey(null);
  return (
    <ToggleGroup
      variant="segmented"
      size="compact"
      className="mt-1.5 w-full"
      aria-label={gt("Worlds")}
      value={props.selectedKey === null ? [] : [props.selectedKey]}
      onValueChange={(value) => props.onSelect(value[0] ?? null)}
    >
      {props.worlds.map((world) => (
        <Toggle
          key={world.id}
          value={worldScopeKey(world.id)}
          className="min-w-0 flex-1"
          title={gt("Show only {world}", { world: world.title })}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {world.project ? (
              <ProjectFavicon project={world.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-left text-xs">{world.label}</span>
            {/* A pressed world's count is the Needs you shelf right below it. */}
            {world.needsYou > 0 && props.selectedKey !== worldScopeKey(world.id) ? (
              <Badge variant="warning" size="sm">
                {world.needsYou}
              </Badge>
            ) : null}
          </span>
        </Toggle>
      ))}
      {props.outsideNeedsYou === null ? null : (
        <Toggle
          value={looseKey}
          className="shrink-0"
          aria-label={gt("Show only threads outside worlds")}
          title={gt("Show only threads outside worlds")}
        >
          <MessageSquareDashedIcon className="size-3.5" />
          {props.outsideNeedsYou > 0 && props.selectedKey !== looseKey ? (
            <Badge variant="warning" size="sm">
              {props.outsideNeedsYou}
            </Badge>
          ) : null}
        </Toggle>
      )}
    </ToggleGroup>
  );
}

const SHOWN_REPOS = 2;

/** The repos a world thread checked out, as its row's first line names them. */
export function SidebarWorldRepoChips(props: { readonly repos: ReadonlyArray<ThreadWorldRepo> }) {
  const gt = useGT();
  const hidden = props.repos.slice(SHOWN_REPOS);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {props.repos.slice(0, SHOWN_REPOS).map((repo) => (
        <Badge
          key={repo.dir}
          variant="secondary"
          size="sm"
          className="min-w-0 shrink justify-start"
          title={repo.work ? gt("{dir}: holds work no remote has", { dir: repo.dir }) : repo.dir}
        >
          {repo.work ? <span className="size-1.5 shrink-0 rounded-full bg-warning" /> : null}
          <span className="min-w-0 truncate">{worldRepoName(repo)}</span>
        </Badge>
      ))}
      {hidden.length > 0 ? (
        <Badge
          variant="secondary"
          size="sm"
          title={hidden.map((repo) => worldRepoName(repo)).join(", ")}
        >
          {hidden.some((repo) => repo.work) ? (
            <span className="size-1.5 shrink-0 rounded-full bg-warning" />
          ) : null}
          +{hidden.length}
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * The world's color down the card's edge: solid for a world thread, dashed for a thread of an
 * older project filed under the world.
 */
export function SidebarWorldStripe(props: {
  readonly color: ProjectIconColor;
  readonly filed: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-y-2.5 left-1 z-20 w-[3px] rounded-full",
        projectIconColorClassName(props.color),
        props.filed ? "border-l-2 border-dashed border-current opacity-70" : "bg-current",
      )}
    />
  );
}
