# Questions survive agent messages

## Requirement

A question or approval an agent asks the user must stay answerable while other agents message that
thread. If the provider drops it anyway, the thread must stop offering it.

## Why upstream does not meet it

`t3_thread_send` in `auto` mode steers a running turn. Claude steers go out at priority `now`, and
Claude Code then aborts the pending AskUserQuestion or approval. A coordinator that messages a team
lead while the lead waits on the user deletes the user's question. Upstream's Claude adapter now
closes a request Claude withdraws (`cancelWithdrawnRequest`, #27320), so the thread stops offering
it, but the question is still gone.

## Design

- `ThreadManagementService.sendToThread` queues an `auto` message that an agent or the system sent
  when the thread has a pending runtime request. The user's own messages still steer, since a
  user who types instead of answering means to redirect the agent. Explicit `steer` and `restart`
  are unchanged.

## Removal

Remove this when upstream stops agent steers from cancelling pending user requests.

## Verification

`ThreadManagementService.test.ts`: "an agent's message queues behind a question the thread is
waiting on".
