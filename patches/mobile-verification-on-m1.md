# Mobile verification on m1

## Fork requirement

Agents on srv-2 or dev-hauke must prove a change on a simulator or emulator of the m1 Apple
builder in minutes, without building a native client on demand. Upstream's shared native-client
cache and its CI belong to upstream's account, which fork hosts cannot write.

## Implementation

- Calder's `native-clients` step (`.calder/ci.ts`) runs `scripts/mobile-native-client.ts ensure
  --prepare` for iOS and arm64 Android on m1 when a push to `main` changes mobile inputs. The
  clients land in m1's local cache (`~/.cache/t3code/native-clients`), where `vp run
  mobile:install` on m1 finds them. That cache keeps three fingerprints per platform, so builds of
  several native branches can evict main's until its native inputs change again.
- `.agents/skills/test-t3-mobile/scripts/start-session.sh` runs the backend and Metro from the
  agent's checkout, tunnels both to the device host over compressed SSH (Metro's multipart bundle
  response is uncompressed, 35 MB over m1's hotspot uplink), syncs the checkout to
  `~/Developer/t3code-mobile-session` on m1 to install the matching client, opens the app and pairs it.
- `scripts/mobile-native-client.ts` and `pair-client.sh` look up the dev client by
  `scripts/lib/mobile-app-ids.ts`, which follows the fork's iOS bundle identifiers
  (`patches/mobile-ios-bundle-identifiers.md`). Upstream hard-codes `com.t3tools.t3code.dev`.
- Native client builds run Gradle without a daemon and compile Kotlin in-process. A one-off
  build otherwise leaves a 4 GB Gradle daemon and Kotlin daemons idle for hours on m1's 16 GB.

## Removal

Drop the `native-clients` step once the fork has a shared cache it can write. Drop the app id
lookup when upstream reads the bundle identifier from the Expo config. The session script and the
Gradle flags stay as long as m1 is the fork's device host.
