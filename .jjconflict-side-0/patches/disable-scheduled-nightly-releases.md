# Disable Scheduled Nightly Releases

## Goal

Keep this personal fork from running upstream's automatic nightly release workflow.

## Source Context

- Upstream's release workflow was configured with `schedule: cron: "0 */3 * * *"`.
- The scheduled path generated nightly release candidates when `main` changed since the previous
  nightly tag.
- On this fork, those automatic release checks are noise and can generate GitHub notifications even
  when no fork work is happening.

## Requirements

- Do not run the release workflow on a cron schedule in this fork.
- Preserve tag-triggered stable releases.
- Preserve manual `workflow_dispatch` releases, including manually selected `nightly` releases.
- Remove schedule-only jobs and conditions so the workflow does not depend on skipped cron
  scaffolding.

## Upstream Touch Points

- `.github/workflows/release.yml`

## Revisit When

- This fork needs automatic nightly publishing.
- Upstream changes the release workflow enough that scheduled publishing is no longer noisy or is
  guarded by repository ownership.

## Verification

- `rg -n "schedule|cron|check_changes" .github/workflows/release.yml` should find no scheduled
  release trigger or schedule-only gate.
- Required repo gates: `vp check` and `vp run typecheck`.
