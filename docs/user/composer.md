# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Reply inline

Hover an assistant paragraph or list item and choose the reply action to write directly beneath it.
You can also select part of the assistant's text and use the contextual Reply action. Add as many
responses as needed, optionally type an overall note in the main composer, then use its Send button
to submit everything as one message.

Press Escape in an inline editor to remove that reply draft.

On mobile, an empty composer shows an interrupt button while the agent is working. Adding text
or an attachment replaces it with the send button. This applies to both compact and expanded
composers.

On web and desktop, sending while the agent is working adds the message to the queue controls
above the composer. It enters the conversation only when T3 Code dispatches it. You can send a
queued message immediately or remove it before dispatch.

You can attach images up to 10 MB. On servers that support file uploads, you can also
attach videos, text files, PDFs, ZIP archives, and other files. Each file can be up to the limit advertised
by the server, capped at 50 MB. Each message can contain up to eight attachments in total. Files
upload directly to the environment, where your agent can read, copy, or edit them by their file path.

Attachments upload as soon as you add them while connected to a server that supports uploads.
The send button becomes available after every upload finishes. Failed uploads can be retried or
removed. On mobile, tap **+** to open
the photo library from either the compact or expanded composer. When the connected server supports
file uploads, **+** opens a menu beside the button with **Photo Library** and **Choose Files**.
Videos use the server's file upload limit. You can also share photos, videos, and files into
T3 Code from other apps through the system share sheet. Mobile keeps a local copy of each draft
attachment, so you can still preview it and queue messages while offline. Uploads resume when
you reconnect. Drafts and queued messages survive app restarts; signing out of T3 Connect keeps
them on your device until you sign back into the same account. Select a received file on mobile
to preview it or open the system share options.

Tap an image or PDF before or after sending to open it. On iOS, images zoom from their thumbnail
into the native viewer. Pinch or double-tap to zoom, and swipe down or tap Close to return.
Use Share to save a copy or send it to another app. PDFs support page navigation and search.
PDF links in assistant responses open the same preview. On Android, images open in the image
viewer and PDFs open the system chooser.

On web and desktop, select a sent PDF or HTML attachment to open it in the file viewer, or use the
download button beside it to save a copy. Other attached files download when selected.

Select a video attachment before or after sending to play it. Web and desktop use the browser's
built-in controls. On mobile, videos open in a full-screen player with native playback controls.
Supported videos show a thumbnail in the conversation and composer.
Received videos stream from their environment as they play on every platform. Supported formats and
codecs depend on the browser or device; you can save an unsupported video to open it in another app.

On iOS, the system player zooms from the attachment. Swipe down or tap Close to return to the
conversation or draft. Touch and hold a video thumbnail, then choose **Save or share** to open
the system share options. On Android, the same menu is also available inside the preview.

On web and desktop, if you reload before a file finishes uploading, the draft keeps the file's name
and shows **Attach again** next to it. Attach the file again or remove it, then send.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message. On iOS, selecting them from **Photo Library** also
converts them to JPEG. The 10 MB image limit applies to the converted photo.

On web and desktop, an existing thread settles its composer into a single-line resting state when
the composer loses focus. At wider sizes, scrolling the conversation also rests a focused composer,
except when scrolling toward the end while already there. When the thread-context strip has room,
the model and mode controls stay available beside the thread context; otherwise they return when the
composer is focused. Focus the composer or start typing to expand it again. The conversation keeps
the expanded composer's space clear above its last message while the composer rests, so expanding it
again never covers what you scrolled to. New-thread layouts keep the full composer. **Settings → General → Collapse composer** chooses which triggers rest it:
**On unfocus**, **On scroll**, both, or neither. With neither selected the composer stays expanded.

At phone-sized web or desktop window widths, existing threads animate between their compact and
expanded layouts. Up to three image attachments remain visible in either resting layout, followed
by a count when more are attached. At wider sizes, videos, files, and other draft context remain
visible at their natural height; the phone-sized compact row reveals those details when expanded.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Model defaults

T3 Code remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft.

Transcription runs on your device. T3 Code deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Queued messages

On web and desktop, the composer shows **Interrupt** while the agent is working and the draft is
empty. Adding text or attachments replaces it with a steer arrow. Click it to send a message into
the active turn, or press `Enter` on desktop. Hold `Cmd` on macOS or `Ctrl` on Windows and Linux to
switch the button to a queue icon. Click while holding that key, or press `Cmd+Enter` or
`Ctrl+Enter` on desktop, to queue the message for after the active turn.

Queued messages appear above the composer. Rows show a thumbnail of any attached image alongside
the text. Drag a row by its handle to reorder it, use the handle's arrow keys, promote the message
to a steer, or remove it.

The pencil on a queued row opens that message in the composer for editing. The original message
stays in the queue until you save, and its row is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** on its row leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On mobile, these menus are available on the **New task** screen before you start a thread. They
use the skills and commands from the selected environment and provider.

In a thread with prior conversation context, send `/compact` to reduce context usage. Web and desktop also offer this action from the context meter, and the work log records token counts when the provider reports them.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

A skill token runs the skill wherever it sits in your message. T3 Code sends it to each provider in
the form that provider runs, so the text before and after the token is kept. Skills that only you may
start, and never the agent on its own, work the same way. A skill you switched off in the provider's
settings does not appear in either menu.

Provider commands such as `/compact` only run when they open the message, so the `/` menu offers
them only there. T3 Code's own commands, such as `/model` and `/plan`, and skills stay available on
any line.

## Skill packs

Skill packs bundle related skills that T3 Code makes available to the agent for a whole thread.
They add to the skills your provider and project already have; those keep working as before. Core
skills are always on, so a thread with no packs still has them.

On web and desktop, the **Skills** control sits in the composer's context strip beside the
workspace control. With no packs selected it shows only an icon; hover it to see **Skills: core**.
Once packs are selected it shows the profile or pack name, or a pack count. A dot marks a thread
that differs from its project default, a dashed dot marks packs that apply on the next turn, and a
warning mark means some skills could not be loaded. Open the control for details.

The **Skills** panel lists profiles first. A profile is a shortcut that selects a set of packs;
the checklist below it is what actually applies, so you can adjust packs after picking a profile.
**Details** shows every skill the selection resolves to and notes skills a pack repeats from core
or another pack. **Reset to project default** returns the thread to its project's packs, and
**Make project default** saves the current selection for new threads in that project. You can also
edit the project default under **Settings → Projects → Skills**.

On mobile, open the thread settings sheet and choose **Skills**. New tasks pick packs the same way
before you start them.

Picking a skill with `$` runs it once in that message and does not change the thread's packs.
Providers that cannot load packs, such as an external OpenCode server, show a note in **Details**
when packs are selected; their own skills still work.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an Open action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If New
worktree is selected, each background thread creates its own worktree.

New worktrees use the generated thread title for their directory and development-instance name.
The name stays fixed after creation even if the thread is renamed later. If naming is unavailable,
T3 Code uses a short `task-…` name instead of copying part of the prompt.
