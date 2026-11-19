/**
 * How turns end, anonymized from real T3 Code threads on the maintainer's hosts (November 2026).
 * `waits` cases end waiting on the user; controls end in status reports or optional offers, which
 * most turn endings of long autonomous threads are. `ask` names what a good ask line mentions.
 */
export interface ThreadAskCase {
  readonly id: string;
  readonly source: string;
  readonly waits: boolean;
  readonly userMessage: string;
  readonly finalMessage: string;
  readonly ask?: RegExp;
}

const realEnding = "Anonymized real turn ending";

export const threadAskCases: ReadonlyArray<ThreadAskCase> = [
  {
    id: "delete-on-hosts",
    source: realEnding,
    waits: true,
    userMessage: "Find out why the skill library has stale entries on the build hosts.",
    finalMessage: `The stale entries come from the old installer, which copied skills into \`~/.agents/skills\` instead of linking them. The new installer links them, so the copies never update.

Leftover copies I found:

| Host | Dirs | Size |
| --- | --- | --- |
| build-1 | 9 | 41 MB |
| build-2 | 7 | 33 MB |
| cache-1 | 5 | 12 MB |
| laptop | ? | asleep |

None of them is referenced by a profile, and the linked versions are current. Should I delete them on those four hosts, and wake the fourth to check it too?`,
    ask: /delet|remov|clean/i,
  },
  {
    id: "which-option-and-issue",
    source: realEnding,
    waits: true,
    userMessage: "The job queue drops jobs under load. Figure out a fix.",
    finalMessage: `Root cause: the worker acknowledges a job before it commits the result, so a crash between the two loses the job. Two ways out:

**Option A: transactional outbox in SQLite.** The worker writes the result and the ack in one transaction. Small change (about 120 lines), no new service, but throughput stays capped at one writer.

**Option B: move the queue to Redis streams.** Consumer groups give us at-least-once delivery and more throughput, but it adds Redis to every deployment and needs a migration for queued jobs.

I'd pick A for now. B is worth an issue so we don't forget the throughput ceiling.

Which option should I build, and should I file the issue?`,
    ask: /option|queue|A or B|build/i,
  },
  {
    id: "open-infra-pr",
    source: realEnding,
    waits: true,
    userMessage: "Fix the crash on startup when the config dir is missing.",
    finalMessage: `Fixed and merged: acme/app#412 creates the config directory on first start instead of assuming it exists. The regression test starts the server with an empty home and passes. Main is at \`4f2c1e9\`.

Production still runs the old build, because the deploy repo pins acme/app to \`b81d07a\`. Bumping the pin is a one-line change in \`hosts/app.nix\`, and the deploy runs on merge.

Should I open the infra PR that bumps the pin?`,
    ask: /pin|infra|PR|deploy/i,
  },
  {
    id: "numbered-when",
    source: realEnding,
    waits: true,
    userMessage: "Add the missing index on orders.customer_id in production.",
    finalMessage: `The migration is ready on branch \`db/orders-customer-index\` and passed on a copy of production. Building the index rewrites 1.2M rows and locks \`orders\` for about 4 minutes, so checkout fails during that window.

When should it run?

1. Now.
2. Tonight at 22:00.
3. You run it yourself.`,
    ask: /migrat|index|when|run/i,
  },
  {
    id: "rename-router-offer",
    source: realEnding,
    waits: true,
    userMessage: "Rename fetchUser to loadUser in the API package.",
    finalMessage: `Renamed \`fetchUser\` to \`loadUser\` in \`packages/api\` and updated its 14 call sites. Typecheck and the API tests pass.

The router in \`apps/web/src/router.ts\` still re-exports it under the old name, which two external plugins import. Want me to rename it in the router too?`,
    ask: /rout|rename/i,
  },
  {
    id: "renew-token",
    source: realEnding,
    waits: true,
    userMessage: "Deploy the release branch to staging.",
    finalMessage: `The staging deploy failed at the push step: the registry rejected the token with \`401 token expired\`. The token lives in your keychain, so I can't renew it from here.

Run \`acme login --registry\` on your laptop and tell me when it's done. Then I'll retry the deploy.`,
    ask: /token|login|log in|sign in|registry/i,
  },
  {
    id: "pick-layout",
    source: realEnding,
    waits: true,
    userMessage: "Mock up a few layouts for the new onboarding screen.",
    finalMessage: `I rendered three onboarding layouts above:

- **Stepper**: one question per screen, progress dots at the top.
- **Checklist**: all steps on one page, each expands in place.
- **Split**: explanation on the left, the form on the right.

The stepper tests best on phones; the split works only on desktop widths. Pick the one you want and I'll build it. I'll hold off until then.`,
    ask: /layout|onboarding|pick|choose/i,
  },
  {
    id: "force-push-approval",
    source: realEnding,
    waits: true,
    userMessage: "Squash the fixup commits on feature/billing.",
    finalMessage: `I squashed the 6 fixup commits locally. Pushing needs a force-push, which rewrites commits Dana already reviewed, so her review comments will point at commits that no longer exist.

Okay to force-push \`feature/billing\`?`,
    ask: /force|push|billing/i,
  },
  {
    id: "which-account",
    source: realEnding,
    waits: true,
    userMessage: "Wire up the Stripe webhook for refunds.",
    finalMessage: `The refund handler is written and tested against fixture events: it marks the order refunded and emails the customer.

Before I write the webhook config I need one decision: should it point at the production Stripe account or the sandbox? The production one already has three webhooks, and its signing secret rotates monthly.`,
    ask: /stripe|account|sandbox|production|webhook/i,
  },
  {
    id: "conflicting-rules",
    source: realEnding,
    waits: true,
    userMessage: "Implement retries for failed payment calls per the spec.",
    finalMessage: `I started on the retry wrapper and found a conflict in the spec. Section 3.2 says "retry every failed call three times with backoff", and section 5.1 says "never retry a payment request, to avoid double charges".

Card payments fall under both. Which rule wins for them? Everything else is unambiguous, and I've paused the change until you answer.`,
    ask: /retr|rule|payment|spec/i,
  },
  {
    id: "review-before-merge",
    source: realEnding,
    waits: true,
    userMessage: "Implement the bulk archive action and get it ready to merge.",
    finalMessage: `Bulk archive is implemented: select threads with shift-click, then Archive in the toolbar or press E. Undo restores the whole batch. Tests cover selection, undo, and the keyboard path, and CI is green.

The PR is ready for your review: acme/app#530. I'll merge and deploy it once you approve.`,
    ask: /review|approve|530|PR/i,
  },
  {
    id: "try-on-phone",
    source: realEnding,
    waits: true,
    userMessage: "The share sheet shows the old icon on iOS.",
    finalMessage: `The old icon came from a cached asset catalog in the share extension. I bumped the extension's build number and regenerated the catalog; the simulator now shows the new icon.

The simulator doesn't reproduce the cache your phone had, so please try it on your phone with the new TestFlight build (1.8.2 (311)): open any thread and tap Share. If the sheet shows the new icon, I'll submit the build for review.`,
    ask: /phone|share|icon|TestFlight|try|check/i,
  },
  {
    id: "open-question-midway",
    source: realEnding,
    waits: true,
    userMessage: "Remove the deprecated v1 API.",
    finalMessage: `Removed the v1 routes for projects, threads, and settings, their handlers, and 2,400 lines of tests. The web and desktop clients already use v2.

One open question before I go on: the mobile app 1.6 still calls \`/v1/threads\`, and about 4% of mobile users are on 1.6. Keep that one route until 1.6 is gone, or remove it now and force the update?`,
    ask: /v1|route|mobile|keep|remove/i,
  },
  {
    id: "status-confirm-later",
    source: realEnding,
    waits: false,
    userMessage: "Fix the flaky upload test and get CI green.",
    finalMessage: `The flake came from the test reading the upload before the server flushed it. The test now waits for the \`upload.completed\` event instead of sleeping 200 ms; 50 local runs passed.

Pushed to \`fix/flaky-upload\` and CI started (run 8812). I'll confirm here once the run finishes.`,
  },
  {
    id: "background-wake",
    source: realEnding,
    waits: false,
    userMessage: "Backfill the new search index for all workspaces.",
    finalMessage: `The backfill is running in the background on worker-2: 2.1M documents at about 900 per second, so roughly 40 minutes. It is resumable, so a restart picks up from the last batch.

A background check wakes me when it ends, and I'll verify the document counts per workspace then.`,
  },
  {
    id: "settle-now",
    source: realEnding,
    waits: false,
    userMessage: "Merge the PR once checks pass and make sure production is fine.",
    finalMessage: `Merged acme/app#418 and deleted the branch. The deploy finished at 14:32, the health check is green, and error rates in the last 20 minutes match the day before.

Nothing is left on my side. You can settle the thread now.`,
  },
  {
    id: "tell-me-if-offer",
    source: realEnding,
    waits: false,
    userMessage: "The CSV export runs out of memory on large workspaces. Fix it.",
    finalMessage: `Done: the CSV export now streams rows instead of building the file in memory. Memory stays under 80 MB for the 500k-row fixture (it was 2.3 GB), and a new test covers the streaming path.

The PDF export has the same problem, since it renders the whole table first. Tell me if you want me to start on that.`,
  },
  {
    id: "let-me-know",
    source: realEnding,
    waits: false,
    userMessage: "Scheduled jobs run an hour early since the DST change.",
    finalMessage: `Fixed: the scheduler stored the next run as a local time without an offset, so after the DST change it resolved to the wrong instant. It now stores UTC and converts at display time. Existing schedules were migrated, and the test covers both DST transitions in Europe/Berlin and America/New_York.

Let me know if anything else looks off.`,
  },
  {
    id: "rhetorical-question",
    source: realEnding,
    waits: false,
    userMessage: "Why is the API cache hit rate so low?",
    finalMessage: `Why did almost every request miss the cache? Because the cache key included the request id, which is unique per call, so no two requests ever shared a key.

I removed the request id from the key and replayed yesterday's traffic: the hit rate went from 3% to 91%, and p95 latency dropped from 420 ms to 95 ms. The change is merged in acme/app#421.`,
  },
  {
    id: "next-steps-own",
    source: realEnding,
    waits: false,
    userMessage: "Move reads to the new orders table without downtime.",
    finalMessage: `Step 2 of 4 is done: the schema migration is applied on staging and production, and writes go to both tables.

Next I'm backfilling the new column (about 25 minutes), then I'll switch reads over behind the \`orders.v2\` flag and watch error rates for an hour before removing the old table. No action needed from you.`,
  },
  {
    id: "quoted-question",
    source: realEnding,
    waits: false,
    userMessage: "Address the review comments on the checkout PR.",
    finalMessage: `All four review comments are addressed. The reviewer asked "should this be behind a flag?", so the new checkout is now behind \`acme.newCheckout\`, off by default, and I replied on the PR with how to turn it on.

CI is green on the latest commit and the review is re-requested.`,
  },
  {
    id: "watching-pr",
    source: realEnding,
    waits: false,
    userMessage: "Open a PR for the rate limiter and get it reviewed.",
    finalMessage: `Opened acme/app#518 with the rate limiter and its tests, and requested review from the platform team.

I'm watching it: checks, review comments and the merge wake me, and I'll address comments as they come in.`,
  },
  {
    id: "anything-else-signoff",
    source: realEnding,
    waits: false,
    userMessage: "Bump the Node version in CI to 24.",
    finalMessage: `Bumped Node to 24 in the CI workflow, the Dockerfile, and \`.nvmrc\`. The full CI run passed on the PR, and I merged it.

Anything else you want me to look at?`,
  },
  {
    id: "went-with-default",
    source: realEnding,
    waits: false,
    userMessage: "Add pagination to the threads endpoint.",
    finalMessage: `Added cursor pagination to \`GET /threads\`: \`limit\` (default 50, max 200) and an opaque \`cursor\`. The clients now load the next page when the list scrolls near the end.

I went with cursors rather than offsets, since offsets skip rows when threads are archived mid-scroll. Say if you'd rather have offsets for the admin export.`,
  },
  {
    id: "ci-still-running",
    source: realEnding,
    waits: false,
    userMessage: "Babysit acme/app#530 until it merges.",
    finalMessage: `Checked #530 after the wake: CI is still running (4 of 7 jobs done, no failures so far) and there are no new review comments. Nothing to do yet; the next check or comment wakes me again.`,
  },
  {
    id: "does-that-help",
    source: realEnding,
    waits: false,
    userMessage: "How does the session token get refreshed on mobile?",
    finalMessage: `The mobile app refreshes the session token in \`useSessionRefresh\`: it schedules a refresh 5 minutes before expiry, and on a 401 it refreshes once and retries the request. If the refresh itself fails, it signs out and shows the pairing screen. The refresh token lives in the keychain, so it survives app restarts.

Does that answer it?`,
  },
  {
    id: "follow-ups-saved",
    source: realEnding,
    waits: false,
    userMessage: "Finish the audit log feature.",
    finalMessage: `The audit log is complete: every admin action writes an entry, the settings page lists them with filters, and exports work for CSV and JSON. Tests cover the writer and both exports.

Two things are out of scope here, so I saved them as follow-ups instead of leaving them in this thread:

- whether entries older than a year should be archived;
- an API endpoint for the log, if the enterprise customers ask for one.`,
  },
];
