import { ClaudeAI, OpenAI } from "../Icons";
import { cn } from "~/lib/utils";
import type { DelegationGlyph } from "./fixtureData";

const GLYPH_LABELS: Record<DelegationGlyph, string> = {
  codex: "Codex",
  claude: "Claude",
  glm: "GLM",
};

/**
 * One worker's provider mark, plus the amber review dot when that worker is
 * the reason the batch is blocked.
 *
 * GLM has no mark in this repo and reaching for the OpenCode logo would claim
 * a provider the lane never names, so it gets the monogram the provider picker
 * already falls back to.
 */
export function WorkerGlyph({
  glyph,
  needsReview = false,
  className,
  indicatorBackground = "var(--card)",
}: {
  readonly glyph: DelegationGlyph;
  readonly needsReview?: boolean;
  readonly className?: string;
  /** Ring colour behind the review dot so it reads on whatever it sits on. */
  readonly indicatorBackground?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      {glyph === "codex" ? (
        <OpenAI aria-hidden className="size-full" />
      ) : glyph === "claude" ? (
        <ClaudeAI aria-hidden className="size-full" />
      ) : (
        <span
          aria-hidden
          className="flex size-full items-center justify-center rounded-[.25rem] border border-border/70 font-semibold text-[.5rem] leading-none text-muted-foreground"
        >
          G
        </span>
      )}
      {needsReview ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning"
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
        />
      ) : null}
      <span className="sr-only">
        {GLYPH_LABELS[glyph]}
        {needsReview ? " needs review" : ""}
      </span>
    </span>
  );
}
