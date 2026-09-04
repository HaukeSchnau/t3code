import type { SkillPackCatalog, SkillPackId } from "@t3tools/contracts";
import {
  describeSkillPackSkills,
  formatSkillPackSelectionLabel,
  formatSkillPackSelectionSummary,
  resolveEffectiveSkills,
  toggleSkillPackId,
  type SkillPackSelection,
} from "@t3tools/client-runtime/skillPacks";
import { BlocksIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useId, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

/**
 * Everything a surface needs to show and edit the packs for one thread or
 * draft. The host resolves the selection and owns persistence; this file only
 * renders it.
 */
export interface SkillPacksControlProps {
  catalog: SkillPackCatalog;
  selection: SkillPackSelection;
  /** Set when the active provider ignores pack injection; shown in details. */
  providerWarning: string | null;
  onPackIdsChange: (packIds: ReadonlyArray<SkillPackId>) => void;
  onResetToProjectDefault: () => void;
  onMakeProjectDefault: () => void;
}

/** Override, pending, and degraded states each get one small mark beside the icon. */
function SkillPacksStatusGlyph({ selection }: { selection: SkillPackSelection }) {
  if (selection.state === "degraded") {
    return <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0 text-warning" />;
  }
  if (selection.state === "pending") {
    return (
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full border border-current border-dashed opacity-80"
      />
    );
  }
  if (selection.source === "thread") {
    return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />;
  }
  return null;
}

function PanelHeading({ children }: { children: ReactNode }) {
  return (
    <div className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
      {children}
    </div>
  );
}

/**
 * The popover body. Profiles are one-tap shortcuts that replace the pack
 * list; the checklist below is the source of truth. Resolved skills and the
 * provider note stay folded unless the scope is degraded.
 */
export function SkillPacksPanel({
  catalog,
  selection,
  providerWarning,
  onPackIdsChange,
  actions,
}: Pick<SkillPacksControlProps, "catalog" | "selection" | "providerWarning" | "onPackIdsChange"> & {
  actions?: Pick<SkillPacksControlProps, "onResetToProjectDefault" | "onMakeProjectDefault">;
}) {
  const headingId = useId();
  const [detailsOpen, setDetailsOpen] = useState(selection.state === "degraded");
  const effectiveSkills = resolveEffectiveSkills(catalog, selection.packIds);
  const selectedPacks = catalog.packs.filter((pack) => selection.packIds.includes(pack.id));

  return (
    <div aria-labelledby={headingId} className="flex w-full flex-col gap-3 text-sm" role="group">
      <div className="flex items-baseline justify-between gap-2">
        <span id={headingId} className="font-medium text-foreground">
          Skills
        </span>
        <span className="text-muted-foreground text-xs">Core skills are always on.</span>
      </div>

      {catalog.profiles.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <PanelHeading>Profiles</PanelHeading>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Skill profiles">
            {catalog.profiles.map((profile) => {
              const active = selection.profile?.id === profile.id;
              return (
                <Tooltip key={profile.id}>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={active ? "secondary" : "outline"}
                        size="xs"
                        role="radio"
                        aria-checked={active}
                        onClick={() => onPackIdsChange(profile.packIds)}
                      />
                    }
                  >
                    {profile.displayName}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{profile.description}</TooltipPopup>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <PanelHeading>Packs</PanelHeading>
        {catalog.packs.length === 0 ? (
          <span className="text-muted-foreground text-xs">No packs are available.</span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {catalog.packs.map((pack) => {
              const checked = selection.packIds.includes(pack.id);
              return (
                <li key={pack.id}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent/60">
                    <Checkbox
                      checked={checked}
                      className="mt-0.5"
                      onCheckedChange={() =>
                        onPackIdsChange(toggleSkillPackId(catalog, selection.packIds, pack.id))
                      }
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-foreground leading-4">{pack.displayName}</span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {pack.description}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger className="group/skills-details flex w-full items-center gap-1 rounded-sm text-muted-foreground text-xs hover:text-foreground">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3 transition-transform group-data-[panel-open]/skills-details:rotate-90"
          />
          <span>Details</span>
          <span className="ml-auto tabular-nums">{effectiveSkills.length} skills</span>
          {selection.state === "degraded" ? (
            <TriangleAlertIcon aria-hidden="true" className="size-3 text-warning" />
          ) : null}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-2 pt-2 text-xs">
            {selection.state === "degraded" ? (
              <p className="rounded-md bg-warning/8 px-2 py-1.5 text-warning-foreground">
                {selection.issue ?? "Some skills could not be injected for this thread."}
              </p>
            ) : selection.state === "pending" ? (
              <p className="text-muted-foreground">Applies on the next turn.</p>
            ) : null}
            {providerWarning ? (
              <p className="rounded-md bg-warning/8 px-2 py-1.5 text-warning-foreground">
                {providerWarning}
              </p>
            ) : null}
            <dl className="flex flex-col gap-1.5">
              <div className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground">Core</dt>
                <dd className="text-foreground">
                  {catalog.coreSkillIds
                    .map(
                      (skillId) =>
                        catalog.skills.find((skill) => skill.id === skillId)?.displayName ??
                        skillId,
                    )
                    .join(", ")}
                </dd>
              </div>
              {selectedPacks.map((pack) => (
                <div key={pack.id} className="flex flex-col gap-0.5">
                  <dt className="text-muted-foreground">{pack.displayName}</dt>
                  <dd className="text-foreground">
                    {describeSkillPackSkills(catalog, pack, selection.packIds).map((row, index) => (
                      <span key={row.skill.id}>
                        {index > 0 ? ", " : ""}
                        {row.skill.displayName}
                        {row.providedBy ? (
                          <span className="text-muted-foreground">
                            {" "}
                            (already in{" "}
                            {row.providedBy === "core"
                              ? "core"
                              : (catalog.packs.find((candidate) => candidate.id === row.providedBy)
                                  ?.displayName ?? row.providedBy)}
                            )
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </CollapsiblePanel>
      </Collapsible>

      {actions ? (
        <div className="flex flex-wrap justify-end gap-1.5 border-border/60 border-t pt-2.5">
          <Button
            variant="ghost"
            size="xs"
            disabled={selection.isProjectDefault}
            onClick={actions.onResetToProjectDefault}
          >
            Reset to project default
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={selection.isProjectDefault}
            onClick={actions.onMakeProjectDefault}
          >
            Make project default
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Context-strip trigger. Core-only with no project default is icon-only; any
 * other selection shows its short label, muted when it merely mirrors the
 * project default. The strip's compact mode hides the label like its
 * neighbours do.
 */
export const SkillPacksControl = memo(function SkillPacksControl({
  catalog,
  selection,
  providerWarning,
  onPackIdsChange,
  onResetToProjectDefault,
  onMakeProjectDefault,
}: SkillPacksControlProps) {
  const [open, setOpen] = useState(false);
  const summary = formatSkillPackSelectionSummary(catalog, selection);
  const showLabel = selection.source !== "core";
  const label = formatSkillPackSelectionLabel(catalog, selection);

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={summary}
                  data-composer-context-control
                  className={cn(
                    "min-w-0 shrink justify-start gap-1 font-normal text-xs! hover:text-foreground/80",
                    selection.source === "thread"
                      ? "text-muted-foreground"
                      : "text-muted-foreground/70",
                  )}
                />
              }
            />
          }
        >
          <BlocksIcon className="size-3 shrink-0" />
          {showLabel ? (
            <span
              data-composer-label
              className="min-w-0 max-w-[160px] group-data-[compact]/composer-context:max-w-0"
            >
              <span
                data-composer-label-motion
                className="block w-full min-w-0 max-w-[160px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
              >
                {label}
              </span>
            </span>
          ) : null}
          <SkillPacksStatusGlyph selection={selection} />
        </TooltipTrigger>
        <PopoverPopup
          side="top"
          align="start"
          className="w-80"
          viewportClassName="py-3 [--viewport-inline-padding:--spacing(3)]"
          {...composerFloatingLayerProps}
        >
          <SkillPacksPanel
            catalog={catalog}
            selection={selection}
            providerWarning={providerWarning}
            onPackIdsChange={onPackIdsChange}
            actions={{ onResetToProjectDefault, onMakeProjectDefault }}
          />
        </PopoverPopup>
      </Popover>
      <TooltipPopup side="top">{summary}</TooltipPopup>
    </Tooltip>
  );
});
