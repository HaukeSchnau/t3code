# Restart continuations resume held queues

## Requirement

Agents message each other's threads with `t3_thread_send`, and those messages queue behind the
target's running turn. A server restart must not strand them. Once the target's interrupted turn
ends, its queued messages run, whether a person or another thread sent them.

## Why upstream doesn't meet it

Restart recovery holds every queued run. A message sent from the web or mobile client, or
**Resume**, releases the hold. Since #27221, a run that completes also releases held messages that
agents and scheduled tasks queued, but it keeps user-queued messages held for the person to review.
The fork releases those too: a person who queued a message behind an interrupted turn expects it to
run once that turn resumes.

## Implementation

`dispatchMessage` in `apps/server/src/orchestration-v2/Orchestrator.ts` releases held runs for a
message with `restartContinuationOfRunId`, as it does for client messages, including runs a person
queued. Recovery still holds the queue, so a restart without a continuation (the preference is off,
the turn was stopped, or it never started and recovery requeued it) keeps upstream's behavior.
`runtimeLayer.test.ts` ("delivers a restart-held queue, including a provider wake, after the
continuation") covers the release and the queue draining after the continuation.

## Removal

Delete this if upstream releases user-queued runs when a restart continuation starts, or Hauke
accepts holding them for review.
