# Conflict-reduction boundaries

Recurring upstream merges showed that most fork conflicts concentrated in a few upstream-owned convergence
files. Fork behavior now lives behind narrow modules while the original files remain stable composition
facades. Preserve these ownership boundaries when extending a fork patch.

## Server boundaries

- `apps/server/src/ws.ts` is a transport/composition adapter. Subscription and replay policy belongs in
  `orchestration/transport/OrchestrationSubscriptionWorkflow.ts`; durable dispatch policy belongs in
  `orchestration/transport/OrchestrationCommandDispatchWorkflow.ts`; Codex resume/fork RPC policy belongs in
  `provider/CodexThreadRpcWorkflow.ts`.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` owns runtime lifecycle composition.
  Transcript journal recovery/delivery belongs in `ProviderTranscriptJournalIngestion.ts`; subagent activity,
  usage limits, event-ledger deduplication, and observed media belong in their adjacent policy modules.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` is the public read facade. Operational,
  thread-activity, snapshot/search, and row-mapping implementation belongs in the adjacent
  `Projection*Reads.ts` and `ProjectionReadMappings.ts` modules.

Keep public service shapes, RPC contracts, receipt semantics, event order, and replay pagination stable. Add a
new boundary only when it gives one existing concept a clear owner; do not move unrelated upstream code merely
to reduce line counts.

## Client boundaries

- `ChatView.tsx` composes thread presentation. Submission belongs in `chat/ThreadTurnSubmission.ts`, durable
  outbox projection and queued-message controls in `chat/useThreadDurableOutbox.ts`, previous-message editing
  in `chat/usePreviousMessageEditing.tsx` plus `chat/previousMessageEditing.ts`, historical hydration in
  `chat/useHistoricalTurnHydration.ts`, and Codex message forking in `chat/useCodexMessageForking.ts`.
- `MonitorView.tsx` uses the same submission and queued-message adapters instead of maintaining parallel
  transaction logic.
- Mobile `ThreadRouteScreen.tsx` owns routing only. Pending creation presentation lives in
  `PendingThreadCreationScreen.tsx`; conversation-local composer, request, and outbox state lives in
  `ThreadDetailScreen.tsx`.

## Sync workflow

Regenerate `pnpm-lock.yaml` from the resolved manifests with `pnpm run fork:lockfile`; never hand-merge it.
Run `pnpm run fork:reconciliation-report` after an upstream merge to compare the current fork footprint with
the historical conflict hotspots. When upstream satisfies a documented requirement, delete the fork path and
update the corresponding patch note rather than preserving both implementations.

## Focused verification

- Server: package typecheck plus the workflow, ingestion, projection, replay, recovery, and Codex-focused tests.
- Web: package typecheck plus submission, outbox, editing, hydration, and Chat/Monitor-focused tests.
- Mobile: package typecheck plus pending-navigation and outbox-focused tests.
- Tooling: `fork:lockfile:check`, reconciliation script tests, and deploy-lock validation.
