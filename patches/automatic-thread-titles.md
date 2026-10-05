# Automatic thread titles

## Context

Upstream titles a thread once, from its first message, and regenerates it only when someone asks.
The first message is often a poor summary: a vague link, "fix this", or the first of several
symptoms. The fork keeps generated titles aligned with the conversation as its durable goal
becomes clearer or changes, using the inexpensive text-generation model.

## Required behavior

- New and generated titles are automatic. A rename by the user or by an agent through
  `t3_thread_update` makes the title manual. Regeneration, from the thread menu or
  `regenerate_title`, makes it automatic again once the request lands, even if the title stays
  the same. Forks and subagent threads inherit the mode of the thread they came from.
- A manual title also survives the first message. The server skips the title seed and first-message
  generation for it.
- After a later user-authored message, the server refreshes an automatic title. Notifications,
  delegated results, scheduled prompts, and provider echoes do not count. The refresh prompt keeps
  an accurate title and changes it only for a meaningful specificity gain or a clear user-led topic
  shift, so ordinary progress does not churn it.
- Refreshes are debounced for five seconds and latest-wins per thread, and at most three generate
  at once. A follow-up during a running refresh interrupts it and starts over.
- A refresh never overwrites a manual title or a title renamed while it ran. It lands only if the
  thread is still automatic, still has the title the refresh started from, and has no first-message
  or explicit generation in flight.
- Refreshes show no in-progress state. The sidebar's regenerating state belongs to first-message
  and explicit generation.
- Turning off **Automatic thread titles** (`refreshGeneratedThreadTitles`, default on) stops
  refreshes. First-message generation and explicit regeneration keep working. Web and desktop show
  the switch in **Settings → General → Text generation**, mobile in **Settings → Thread behavior**.
- Threads without a title mode keep their titles until regenerated. These are v1 imports and v2
  threads created before this patch. Carrying the fork's v1 `title_mode` column over would need a
  hook in upstream's v1 importer; leaving imported titles alone until the user regenerates them is
  the simpler rule.
- Every provider that implements title generation receives the refresh flag. Provider choice
  follows the text-generation model setting.

## Implementation

Fork-owned files:

- `apps/server/src/orchestration-v2/ThreadTitleRefresh.ts` subscribes to domain events, debounces
  per thread, generates, and lands the result with a guarded
  `thread.title.regeneration.complete`.
- `apps/server/src/orchestration-v2/threadTitleMode.ts` decides whether a finished generation may
  land. It is a separate module so the orchestrator can import it without a cycle.
- `apps/server/src/orchestration-v2/ThreadTitleRefresh.test.ts`

Upstream-owned hooks:

- `packages/contracts/src/orchestrationV2.ts`: optional `titleMode` on `OrchestrationV2AppThread`,
  stored in the thread's `payload_json` with no migration, and optional `expectedTitle` on
  `thread.title.regeneration.complete`.
- `packages/contracts/src/settings.ts`: `refreshGeneratedThreadTitles` in server settings and the
  patch schema.
- `apps/server/src/orchestration-v2/Orchestrator.ts`: `titleMode: "automatic"` on `thread.create`;
  `titleMode: "manual"` when `thread.metadata.update` carries a title; the completion guard calls
  `acceptsGeneratedTitle` and sets the mode to automatic; the first-message title block skips
  manual titles.
- `apps/server/src/server.ts`: starts the refresh reactor next to the other thread workers.
- `apps/server/src/textGeneration/TextGeneration.ts`, `TextGenerationPrompts.ts`, and each
  provider's `*TextGeneration.ts`: the `automaticRefresh` flag and its stricter prompt rule.
- `apps/web/src/components/settings/SettingsPanels.tsx` and `settingsSearch.ts`: the settings row,
  its search entry, dirty label, and reset.
- `apps/mobile/src/features/settings/SettingsThreadsRouteScreen.tsx`: the mobile switch.

## Removal

Retire this patch when upstream tracks generated versus manual titles and refreshes generated
titles after later turns with the same stability rule, rename protection, and coalescing.

## Verification

- `apps/server/src/orchestration-v2/ThreadTitleRefresh.test.ts` covers mode transitions, manual
  first-message titles, a coalesced refresh after later turns, the first-turn, manual, and
  disabled cases, and a rename winning over an in-flight refresh.
- `apps/server/src/textGeneration/TextGenerationPrompts.test.ts` covers the refresh prompt rule.
