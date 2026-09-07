# Provider turn recovery

The V1 provider-command and ingestion reactors are superseded by upstream V2 runs, attempts, provider turns, event persistence, and effect recovery. They must not be started alongside the native runtime.

## Retained requirements

- Accepted work has durable preparing/starting state before provider I/O can block.
- Provider failures and process loss must leave a terminal or recoverable native run, not a permanently busy placeholder.
- Imported conversations retain native continuation references. A successful native resume must not receive its entire old transcript again as a handoff.
- Assistant delivery and replay stay bounded. Provider lifecycle ordering and terminal barriers must survive buffered delivery.
- Preserve the server streaming preference through the native execution path.

Current execution lives in `orchestration-v2/RunExecutionService.ts`, `ProviderTurnStartService.ts`, and `ProviderRuntimeRecoveryService.ts`. Historical V1 transcript-journal tables remain migration data. New semantic provider snapshots commit to `provider_event_journal` before adapter queue delivery. The native event sink retires journal identities in the same transaction as projection writes. Startup replays pending snapshots before terminalizing stale runs and before starting provider workers. Native provider-context resume alone is not transcript recovery.

Use native recovery and replay tests when updating this behavior. Do not retain an old test harness by reintroducing the removed V1 runtime services.

The journal implementation is `orchestration-v2/ProviderEventJournal.ts`; startup replay is `ProviderEventJournalReplay.ts`. `EventSinkJournal.test.ts` covers interrupted intake, atomic retirement, duplicate suppression, and parent/subagent replay. A later committed snapshot retires earlier pending snapshots of the same entity, so a deliberately withheld streaming update cannot overwrite the final answer after restart.
