# Pull request watch wakes on merge

## Fork requirement

When a watched pull request merges, the agent gets one last wake, just as it does when the pull
request closes. In this fork a merge bot (Calder) often merges while the agent waits, and the agent
may still owe a step after the merge: following the deploy or release, or reporting the merge commit.
Without the wake the watch ended silently, the thread kept its "waiting on CI" message, and nothing
showed that the pull request had merged.

Upstream ends a merged pull request's watch without a wake and stops counting it as pending work,
so a thread can auto-settle as soon as the merge is visible (upstream #26395).

## Behavior

- `PullRequestWatchReactor` ends the watch and sends one `monitor` wake, summary
  `#<n>: merged, stopped watching`, whether a host read or the link snapshot shows the merge first.
- A settled thread or a subagent still ends its watch without a wake.
- `derivePendingBackgroundWork` keeps counting a merged pull request's watch until the reactor ends
  it, so auto-settle on merge cannot hide the thread before the wake arrives.

## Removal

Drop this when upstream wakes the agent on merge, or when agents no longer need a post-merge step,
for example if deploy tracking moves into a T3 watch of its own.
