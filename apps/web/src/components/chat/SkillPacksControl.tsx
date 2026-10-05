import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  SkillPackCatalog,
  SkillPackId,
  ThreadId,
} from "@t3tools/contracts";
import {
  describeSkillPackSkills,
  formatSkillPackSelectionLabel,
  formatSkillPackSelectionSummary,
  resolveEffectiveSkills,
  resolveSkillPackProviderWarning,
  resolveSkillPackSelection,
  toggleSkillPackId,
  type SkillPackSelection,
} from "@t3tools/client-runtime/skillPacks";
import { BlocksIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useId, useState, type ReactNode } from "react";

import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  readDraftSkillPackIds,
  skillPackEnvironment,
  useDraftSkillPackIds,
  useDraftSkillPacksStore,
} from "../../state/skillPacks";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

/** Fork: skill packs (patches/skill-packs.md). */
export interface SkillPacksEditor {
  readonly catalog: SkillPackCatalog;
  readonly selection: SkillPackSelection;
  /** Set when the active provider never loads packs; shown in Details. */
  readonly providerWarning: string | null;
  readonly onPackIdsChange: (packIds: ReadonlyArray<SkillPackId>) => void;
}

/** First-turn bootstrap field for a draft's picks; absent follows the project default. */
export function draftSkillPackBootstrap(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): { readonly skillPackIds?: ReadonlyArray<SkillPackId> } {
  const skillPackIds = readDraftSkillPackIds(environmentId, threadId);
  return skillPackIds === undefined ? {} : { skillPackIds };
}

/** Override, pending, and degraded states each get one small mark beside the icon. */
function SkillPacksStatusGlyph({ selection }: { readonly selection: SkillPackSelection }) {
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

function PanelHeading({ children }: { readonly children: ReactNode }) {
  return (
    <div className="font-medium text-2xs text-muted-foreground uppercase tracking-wide">
      {children}
    </div>
  );
}

/**
 * Profiles are one-tap shortcuts that replace the pack list; the checklist is
 * what applies. Resolved skills and notes stay folded unless the scope is
 * degraded.
 */
export function SkillPacksPanel({
  catalog,
  selection,
  providerWarning,
  onPackIdsChange,
  actions,
}: SkillPacksEditor & { readonly actions?: ReactNode }) {
  const headingId = useId();
  const [detailsOpen, setDetailsOpen] = useState(selection.state === "degraded");
  const effectiveSkills = resolveEffectiveSkills(catalog, selection.packIds);
  const selectedPacks = catalog.packs.filter((pack) => selection.packIds.includes(pack.id));
  const skillName = (skillId: string) =>
    catalog.skills.find((skill) => skill.id === skillId)?.displayName ?? skillId;

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
            {catalog.packs.map((pack) => (
              <li key={pack.id}>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent/60">
                  <Checkbox
                    checked={selection.packIds.includes(pack.id)}
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
            ))}
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
                {selection.issue ?? "Some skills could not be loaded for this thread."}
              </p>
            ) : providerWarning ? (
              <p className="rounded-md bg-warning/8 px-2 py-1.5 text-warning-foreground">
                {providerWarning}
              </p>
            ) : selection.state === "pending" ? (
              <p className="text-muted-foreground">Applies on the next turn.</p>
            ) : null}
            <dl className="flex flex-col gap-1.5">
              <div className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground">Core</dt>
                <dd className="text-foreground">
                  {catalog.coreSkillIds.map(skillName).join(", ")}
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
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The composer's Skills control for a server thread or a draft. Renders
 * nothing unless the environment publishes a catalog. Core only is icon-only;
 * any other selection shows its profile, pack name or count.
 */
export function ComposerSkillPacksControl(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** Drafts keep picks locally until their first turn creates the thread. */
  readonly isServerThread: boolean;
  readonly providerDriver: ProviderDriverKind | null;
  readonly size: ComposerControlSize;
  readonly hidden: boolean;
}) {
  const { environmentId, projectId, threadId, isServerThread } = props;
  const catalog = useEnvironment(environmentId)?.serverConfig?.skillPackCatalog ?? null;
  const state = useEnvironmentQuery(
    catalog === null
      ? null
      : skillPackEnvironment.state({
          environmentId,
          input: isServerThread ? { projectId, threadId } : { projectId },
        }),
  ).data;
  const draftPackIds = useDraftSkillPackIds(environmentId, threadId);
  const setDraftPackIds = useDraftSkillPacksStore((store) => store.set);
  const setThreadPacks = useAtomCommand(skillPackEnvironment.setThreadPacks, "set skill packs");
  const setProjectDefault = useAtomCommand(
    skillPackEnvironment.setProjectDefault,
    "save the project's default skills",
  );
  const composerMenuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);

  const projectDefaultPackIds = state?.projectDefaultPackIds;
  const applyPackIds = useCallback(
    (packIds: ReadonlyArray<SkillPackId> | null) => {
      if (isServerThread) {
        void setThreadPacks({
          environmentId,
          input: { threadId, packIds: packIds ?? projectDefaultPackIds ?? [] },
        });
        return;
      }
      setDraftPackIds(environmentId, threadId, packIds);
    },
    [
      environmentId,
      isServerThread,
      projectDefaultPackIds,
      setDraftPackIds,
      setThreadPacks,
      threadId,
    ],
  );

  if (catalog === null) return null;
  const selection = resolveSkillPackSelection({
    catalog,
    projectDefaultPackIds,
    ...(isServerThread ? { threadScope: state?.thread } : { draftPackIds }),
  });
  const summary = formatSkillPackSelectionSummary(catalog, selection);
  const makeProjectDefault = async () => {
    const result = await setProjectDefault({
      environmentId,
      input: { projectId, packIds: selection.packIds },
    });
    // The draft's picks now match the project, so it follows the default again.
    if (result._tag === "Success" && !isServerThread) {
      setDraftPackIds(environmentId, threadId, null);
    }
  };

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<ComposerControl size={props.size} aria-label={summary} type="button" />}
            />
          }
        >
          <ComposerControlIcon icon={BlocksIcon} size={props.size} />
          {selection.source !== "core" ? (
            <span data-composer-control-label className="max-w-40 truncate">
              {formatSkillPackSelectionLabel(catalog, selection)}
            </span>
          ) : null}
          <SkillPacksStatusGlyph selection={selection} />
        </TooltipTrigger>
        <PopoverPopup side="top" align="start" width="md" padding="compact" {...composerMenuProps}>
          <SkillPacksPanel
            catalog={catalog}
            selection={selection}
            providerWarning={resolveSkillPackProviderWarning({
              driver: props.providerDriver,
              packIds: selection.packIds,
            })}
            onPackIdsChange={applyPackIds}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={selection.isProjectDefault}
                  onClick={() => applyPackIds(null)}
                >
                  Reset to project default
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={selection.isProjectDefault}
                  onClick={() => void makeProjectDefault()}
                >
                  Make project default
                </Button>
              </>
            }
          />
        </PopoverPopup>
      </Popover>
      <TooltipPopup side="top">{summary}</TooltipPopup>
    </Tooltip>
  );
}
