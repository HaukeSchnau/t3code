# Mobile notifications

The iPhone app can alert you when a thread needs you or an agent fails, and when a turn you started
finishes, and can follow ongoing work in a Live Activity. Your paired T3 Code server sends both directly through
Apple's push service. No account is involved, and the app does not need to stay connected.

## Set up

1. Pair the iPhone with your T3 Code server in **Settings → Environments**.
2. Give that server an Apple Push Notification service key from the Apple team that signs the app.
   Start the server with:

   ```text
   T3CODE_APNS_TEAM_ID=<10-character Apple team ID>
   T3CODE_APNS_KEY_ID=<key ID>
   T3CODE_APNS_PRIVATE_KEY_FILE=/absolute/path/to/AuthKey_<key-id>.p8
   ```

   You can pass the key itself in `T3CODE_APNS_PRIVATE_KEY` instead of the file, but not both.
   The key stays on the server.

3. On the iPhone, open **Settings → Notifications** and turn on **Device Notifications**. Turn on
   **Live Activity Updates** to follow work from the Lock Screen and Dynamic Island.

If a switch will not stay on, the server could not accept the phone. Check its APNs settings.

## What to expect

You hear about a thread when it starts needing you: an approval, a question, a guest's message, or a
turn that ends on a question or a decision for you. Failures alert too, even while a question waits. A finished turn
alerts only when you started it with a message of your own. Turns that a wake, a watcher, another
agent or a scheduled task started end without an alert, unless they end on a question.

A finished turn alerts right away. If T3 then finds that it ended on a question, the question
replaces the "Done" notification on the phone without a second sound. Each thing alerts once, also
when the server restarts or you use several devices, and choosing **No reply needed** never brings
back the "Done".

If a question, a guest's message or an agent's ask still waits an hour after it started, you get one
reminder for it, also when the server was restarting at that moment. A snoozed thread reminds an hour after its
snooze ends, or an hour after you wake it. At 7 pm in the server's time zone, if anything needs you, one notification says how many
threads need you and names the one waiting longest.

The app icon's badge shows how many threads need you on the paired server that handles
notifications, counting its subagents' requests on their threads. The app shows the same number
while it is open, and clears it when you remove your last server.

Tap a notification to open its thread. Finished results stay in the Live Activity for up to 15
minutes. Alerts stay quiet while the app is open, but the Live Activity keeps updating. Viewing a
thread on another device does not silence the phone.

You can also add the **Agent Activity** widget to the Home Screen or Lock Screen. It shows the
same work as the Live Activity, refreshes when you open T3 Code, and marks unfinished work out of
date after 10 minutes. Both show how many threads need you, beyond the rows they have room for. The
widget keeps showing the number when no row is left. The watch's **Needs you** counts the same
threads as the badge.

A question has an **Answer** action, and finished or failed work has **Reply**. Both work from the
Lock Screen and from an Apple Watch without opening the app. To answer a question, name one of its
options or answer in your own words. A reply to finished or failed work becomes the agent's next
message. Approvals and questions with several parts still open the app. If a reply doesn't arrive,
a **Reply not delivered** notification says why and offers **Retry** when it can help.

Questions and approvals are Time Sensitive, so they reach you during a Focus. To stop that, turn
off **Time Sensitive Notifications** for T3 Code in the iPhone's Settings app under
**Notifications**.

With several paired environments, the first one the phone reaches handles notifications. Each
server knows only its own threads, so alerts and the Live Activity cover that server's work only.

Removing an environment asks it to forget the phone. If the server is offline at that moment, it
may keep notifying the phone; add it again once it is reachable, then remove it.

Notification permission is controlled in the iPhone's Settings app.

Android devices do not receive agent notifications from a paired server.
