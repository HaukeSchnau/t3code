import {
  worldRefusalLabel,
  worldRepoName,
  worldRepoWork,
  worldSummary,
} from "@t3tools/client-runtime/state/worlds";
import type { EnvironmentId } from "@t3tools/contracts";
import { BanIcon, EarthIcon, FolderGit2Icon, FolderIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useGT, useMessages } from "gt-react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const REFUSALS_SHOWN = 3;

/** A thread world's repos, the work in them no remote has, and refused checkouts (patches/worlds.md). */
export function ThreadWorldPanel(props: { environmentId: EnvironmentId; cwd: string }) {
  const gt = useGT();
  const messages = useMessages();
  const status = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId: props.environmentId, input: { cwd: props.cwd } }),
  );
  const world = status.data?.world;
  if (world === undefined) return null;
  return (
    <ThreadDetailsSection
      title={gt("World", { $context: "a thread's isolated set of repository checkouts" })}
    >
      <ul className="m-0 flex list-none flex-col p-0">
        <Row
          icon={<EarthIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
          title={world.path}
          detail={worldSummary(world, messages)}
          warn={!world.available}
        />
        {world.repos.map((repo) => {
          const work = worldRepoWork(repo, messages);
          const Icon = repo.checkedOut ? FolderGit2Icon : FolderIcon;
          return (
            <Row
              key={repo.repo}
              icon={<Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
              title={worldRepoName(repo)}
              detail={
                work ?? (repo.checkedOut ? gt("Checked out, every remote has it") : gt("Read only"))
              }
              warn={work !== null}
            />
          );
        })}
        {world.refusals.slice(0, REFUSALS_SHOWN).map((refusal) => (
          <Row
            key={`${refusal.at}:${refusal.repo}`}
            icon={<BanIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
            title={gt("Checkout refused")}
            detail={worldRefusalLabel(refusal, messages)}
            warn
          />
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}

function Row(props: { icon: ReactNode; title: string; detail: string; warn?: boolean }) {
  return (
    <li className="flex min-h-9 min-w-0 items-center gap-2.5 ps-2.5 pe-1 py-1.5">
      {props.icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label leading-4 text-foreground">{props.title}</span>
        <span
          className={cn(
            "text-caption leading-4 [overflow-wrap:anywhere]",
            props.warn ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {props.detail}
        </span>
      </span>
    </li>
  );
}
