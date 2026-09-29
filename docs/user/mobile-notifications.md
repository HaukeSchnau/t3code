# Mobile notifications

The iPhone app can alert you when an agent finishes, fails, needs approval, or asks for input, and
can follow ongoing work in a Live Activity. Your paired T3 Code server sends both directly through
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

Tap a notification to open its thread. Finished results stay in the Live Activity for up to 15
minutes. Alerts stay quiet while the app is open, but the Live Activity keeps updating. Viewing a
thread on another device does not silence the phone.

With several paired environments, the first one the phone reaches handles notifications. Each
server knows only its own threads, so alerts and the Live Activity cover that server's work only.

Removing an environment asks it to forget the phone. If the server is offline at that moment, it
may keep notifying the phone; add it again once it is reachable, then remove it.

Notification permission is controlled in the iPhone's Settings app.

Android devices do not receive agent notifications from a paired server.
