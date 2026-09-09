# Working with threads

The sidebar puts threads that need you first, followed by all other active threads. Within each
group, the thread with the most recent user message appears first. Opening a thread, streaming a
response, and tool activity do not change its position.

Project pickers follow the same order: the project containing the highest-ranked live thread appears
first. Projects without live threads follow alphabetically.

Threads created by a coordinator nest below it. Effort headers contain the threads that explicitly
belong to that effort, including forks whose source is elsewhere. Explicit effort membership chooses
the thread's one sidebar location, so the same thread does not also appear below a different creator.
Current and attention-needed efforts appear before completed and closed effort history. T3 Code keeps
their relative order stable within each lifecycle group; elapsed time does not reorder them.

Projects remain a flat list. A top-level thread that has delegated work gets a separate disclosure
control aligned below the project icon; ordinary top-level threads use that space for their full card.
Closing the disclosure hides every descendant, including effort members, unassigned work, retries,
nested coordinators, and past-effort history. Effort, retry, and nested-coordinator sections can still
be opened and closed independently. Their summaries put work that needs you first, then working and
done counts, and finally the number of hidden rows.

Every thread keeps the normal sidebar card and its existing actions, regardless of its depth or
lifecycle. If the thread you are viewing is hidden by a closed section, a **Viewing** row remains next
to its root. Select it to reopen the exact chain of sections leading to that thread. Search results and
the Snoozed and Settled shelves remain flat so a thread still has one predictable lifecycle location.

When a coordinator has efforts and unassigned children, those children appear under **Other delegated
work**. A coordinator with no efforts continues to show its children without a section header.

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

Pinning applies to the individual thread, not its whole delegation tree. When a parent and child
have different pin states, each starts a top-level row in its own pinned or active section. Children
with the same pin state remain nested, so no unpinned row crosses the pinned divider and a pinned
child never disappears with an unpinned parent.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Automatic titles

New threads receive a generated title from their first message. By default, T3 Code keeps that
title aligned with the conversation as later requests make the goal clearer or move to a different
topic. Ordinary progress such as planning, implementation, testing, and review does not change an
otherwise accurate title.

Editing a title yourself stops automatic updates for that thread. Choose **Regenerate title** to
generate a new title from the current conversation and resume automatic updates. Existing threads
from older T3 Code versions remain unchanged until you regenerate their titles.
Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent.

Turn off **Automatic thread titles** in General settings to keep first-message generation
without later automatic updates. Explicit title regeneration remains available.

## Settle finished work

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. Changes apply to connected environments that support shared settings;
offline environments and older servers keep their previous values. If connected
environments disagree, **Apply to all** copies your current settings to those named
in the warning. Changing a rule does not reopen already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.
