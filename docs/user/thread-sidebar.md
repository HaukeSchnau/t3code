# Organizing threads

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

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

Pinning applies to the individual thread, not its whole delegation tree. When a parent and child
have different pin states, each starts a top-level row in its own pinned or active section. Children
with the same pin state remain nested, so no unpinned row crosses the pinned divider and a pinned
child never disappears with an unpinned parent.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. The
confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p` shortcut.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Each server stores its own copy of the automatic settlement settings and checks them even when no
web, desktop, or mobile client is connected. By default, it settles threads after three days without
activity and when their pull request merges. An eligible idle thread also settles when its pull
request closes. An open pull request does not block inactivity settlement. Active work, pending
input, and live background work keep the thread active. T3 Code settles from a closed or merged
pull request only when its timestamp is not older than the user's latest activity. If that timestamp
is not available, the inactivity rule still applies. A manual un-settle also keeps the thread active.

**Settled** lists threads by when their work finished, newest first. A thread you settle yourself
sorts by the moment you settled it. A thread that settled on its own sorts by its last message or
turn, not by when the server noticed it was inactive.

Change these rules in **Settings > General**. The change is written to every connected environment
whose server supports shared settings. An environment that is offline or needs a server update
keeps its old value and does not appear in mismatch warnings. When a connected environment whose
server supports shared settings holds a different value, **Settings > General** shows a warning
that names it. Choose **Apply to all** to write your current values to the environments named in
the warning. The same applies to the new-thread workspace mode and the source control writing
style.

A settings change affects future settlement and does not reopen a settled thread. Settings saved
by older clients on one device no longer control this behavior.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

A thread whose composer holds unsent text or attachments shows an amber tint and a pen icon in the
sidebar, the same marks a new-thread draft uses. On web and desktop, hover the row and choose the
**X** to discard that draft without opening the thread.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Automatic titles

New threads receive a generated title from their first message. By default, T3 Code keeps that
title aligned with the conversation as later requests make the goal clearer or move to a different
topic. Ordinary progress such as planning, implementation, testing, and review does not change an
otherwise accurate title.

Editing a title yourself stops automatic updates for that thread. Choose **Regenerate title** to
generate a new title from the current conversation and resume automatic updates. Existing threads
from older T3 Code versions remain unchanged until you regenerate their titles.

Turn off **Automatic thread titles** in General settings to keep first-message generation
without later automatic updates. Explicit title regeneration remains available.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
