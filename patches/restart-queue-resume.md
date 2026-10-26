# Restart continuations resume held queues

## Requirement

Agents message each other's threads with `t3_thread_send`, and those messages queue behind the
target's running turn. A server restart must not strand them. Once the target's interrupted turn
ends, its queued messages run, whether a person or another thread sent them.

## Why upstream doesn't meet it

Restart recovery holds every queued run, and only a message sent from the web or mobile client,
or **Resume**, releases the hold. The restart continuation resumes the interrupted turn but leaves
the queue held behind it. Later queued messages join the held queue, so a thread that only agents
talk to never runs them again. That includes a provider's own wake turn after a background
command, whose MCP calls then fail with `parent_not_active` because the thread has no live run.

## Implementation

`dispatchMessage` in `apps/server/src/orchestration-v2/Orchestrator.ts` releases held runs for a
message with `restartContinuationOfRunId`, as it does for client messages. Recovery still holds the
queue, so a restart without a continuation (the preference is off, or the turn was stopped) keeps
upstream's behavior. `runtimeLayer.test.ts` covers the release, the queue draining after the
continuation, and the thread reading as a live MCP caller meanwhile.

## Removal

Delete this if upstream resumes or stops holding queued runs after a restart continuation.
