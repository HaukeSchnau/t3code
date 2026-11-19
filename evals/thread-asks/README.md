# Thread asks

Checks the turn-end detector: whether the text-generation model reads a run's final message as waiting on the user, and whether the ask line it writes names what the user must decide or do. The prompt, output schema and sanitizer come from `@t3tools/provider-core` (`buildTurnEndAskPrompt`, `fromRunner`), so the eval runs the server's own path with the Anthropic Messages API in place of the Claude CLI. Structured output stands in for the CLI's `--json-schema`.

## Run

```sh
cd evals
pnpm thread-asks --out runs/asks
pnpm thread-asks --out runs/asks-new --baseline runs/asks/results.jsonl
```

- `ANTHROPIC_API_KEY` in the repo root `.env` pays for the calls.
- Flags: `--model <id>` (default `claude-haiku-5-5`, the cheapest Claude model), `--effort <level>`, `--case <id>` (repeatable), `--samples <n>` (default 3), `--concurrency <n>` (default 6), `--baseline <results.jsonl>`.
- A waiting case passes when the sample waits and its ask is one line under 120 characters, does not start with "The agent", and matches the case's `ask` pattern. A control passes when the sample does not wait. A case fails when half or more of its samples fail.
- A run writes `results.jsonl` (one row per sample) and `summary.md` (pass counts, asks, failures, tokens and cost).
- Cost: a full run of 27 cases at 3 samples is about 90k input tokens on Haiku 5.5, under $0.02.

## What counts as waiting

Most turn endings in long autonomous threads are status reports, so each waiting pattern has a control that looks like it.

- A direct question at the end of finished work counts when the agent waits for the answer before doing that next thing ("Want me to rename it in the router too?"). An optional offer phrased as "Tell me if you want...", "Let me know if...", or "Say if you'd rather..." does not.
- A request for the user's action without a question mark counts ("The PR is ready for your review. I'll merge once you approve.").
- A generic sign-off question ("Anything else?", "Does that answer it?") does not.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, `waits`, the user's latest message, the agent's final message, and for waiting cases an `ask` pattern naming the subject. Use `acme/app`-style names and no user data.
