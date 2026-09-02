import { ClaudeAI, OpenAI } from "../Icons";
import { cn } from "~/lib/utils";
import type { FixtureProvider } from "./model";
import { PROVIDER_LABELS } from "./presentation";

/**
 * One worker's provider mark, with an amber dot when that worker is the
 * reason something needs the user. GLM has no mark in this repo, so it gets
 * the monogram the provider picker already falls back to.
 */
export function WorkerGlyph({
  provider,
  attention = false,
  className,
  indicatorBackground = "var(--card)",
}: {
  readonly provider: FixtureProvider;
  readonly attention?: boolean;
  readonly className?: string;
  readonly indicatorBackground?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      {provider === "codex" ? (
        <OpenAI aria-hidden className="size-full" />
      ) : provider === "claude" ? (
        <ClaudeAI aria-hidden className="size-full" />
      ) : (
        <span
          aria-hidden
          className="flex size-full items-center justify-center rounded-[.25rem] border border-border/70 font-semibold text-[.5rem] leading-none text-muted-foreground"
        >
          G
        </span>
      )}
      {attention ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning"
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
        />
      ) : null}
      <span className="sr-only">
        {PROVIDER_LABELS[provider]}
        {attention ? " needs you" : ""}
      </span>
    </span>
  );
}
