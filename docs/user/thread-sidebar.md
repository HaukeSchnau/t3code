# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

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
