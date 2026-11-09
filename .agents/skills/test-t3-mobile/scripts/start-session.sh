#!/usr/bin/env bash
# Starts an isolated backend and Metro from this checkout, tunnels both to the device host, installs
# the matching dev client there, opens it against Metro and pairs it. Runs until interrupted.

set -euo pipefail

usage() {
  echo "Usage: $0 <device-host> <agent-device-command> <target-args...>" >&2
  exit 2
}

[[ $# -ge 3 ]] || usage
device_host="$1"
agent_device_command="$2"
shift 2
target_args=("$@")

repo_root="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$repo_root"
logs="$repo_root/.t3/mobile-session"
rm -rf "$logs" && mkdir -p "$logs"

platform=""
device=""
for ((i = 0; i + 1 < ${#target_args[@]}; i++)); do
  case "${target_args[i]}" in
    --platform) platform="${target_args[i + 1]}" ;;
    --udid | --serial) device="${target_args[i + 1]}" ;;
  esac
done
if [[ "$platform" != ios && "$platform" != android ]] || [[ -z "$device" ]]; then
  echo "Pass the AgentDevice target arguments from device_open, including --platform and the device id." >&2
  exit 2
fi

# The device reaches both through the tunnel on its host's loopback; Android emulators see it as 10.0.2.2.
origin_host=127.0.0.1
[[ "$platform" == android ]] && origin_host=10.0.2.2
children=()
# Each child leads its own process group, so stopping it also stops the servers it spawned.
cleanup() {
  for pid in "${children[@]}"; do kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'echo "Failed at line $LINENO; logs are in $logs" >&2' ERR

# m1's uplink is a phone hotspot, so device commands sometimes fail once.
retry() {
  for attempt in 1 2 3; do
    "$@" && return 0
    sleep 5
  done
  return 1
}

wait_for_line() {
  local file="$1" pattern="$2" pid="$3"
  until grep -aqE "$pattern" "$file" 2>/dev/null; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Stopped before it was ready; see $file" >&2
      tail -n 20 "$file" >&2
      exit 1
    fi
    sleep 1
  done
}

echo "Starting the backend and Metro..." >&2
setsid node scripts/dev-runner.ts dev:server >"$logs/backend.log" 2>&1 &
children+=("$!")
wait_for_line "$logs/backend.log" "serverPort=[0-9]+" "${children[-1]}"
runner_line="$(grep -aoE "serverPort=[0-9]+ .*baseDir=[^ ]+" "$logs/backend.log" | head -n 1)"
server_port="$(sed -E 's/^serverPort=([0-9]+).*/\1/' <<<"$runner_line")"
base_dir="$(sed -E 's/.*baseDir=//' <<<"$runner_line")"
until curl -s -o /dev/null "http://127.0.0.1:$server_port/"; do
  kill -0 "${children[0]}" 2>/dev/null || { tail -n 20 "$logs/backend.log" >&2; exit 1; }
  sleep 1
done

metro_port="$(node -e 'const s = require("node:net").createServer().listen(0, () => { console.log(s.address().port); s.close(); })')"
(
  cd apps/mobile
  APP_VARIANT=development REACT_NATIVE_PACKAGER_HOSTNAME="$origin_host" \
    exec setsid node_modules/.bin/expo start --dev-client --scheme t3code-dev --lan --port "$metro_port"
) </dev/null >"$logs/metro.log" 2>&1 &
children+=("$!")
wait_for_line "$logs/metro.log" "Waiting on http://" "${children[-1]}"
metro_url="http://$origin_host:$metro_port"

# Metro leaves the dev client's multipart bundle response uncompressed: 35 MB, minutes over m1's
# hotspot uplink. SSH compression brings it to about 6 MB; the loop reconnects after a drop.
setsid bash -c 'while kill -0 "$4" 2>/dev/null; do ssh -S none -o ControlMaster=no -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -C -N -R "$1:127.0.0.1:$1" -R "$2:127.0.0.1:$2" "$3"; sleep 2; done' \
  tunnel "$server_port" "$metro_port" "$device_host" "$$" >"$logs/tunnel.log" 2>&1 &
children+=("$!")
for ((attempt = 0; ; attempt++)); do
  ssh "$device_host" "curl -fs http://127.0.0.1:$metro_port/status" | grep -q packager-status:running && break
  if ((attempt >= 30)); then
    echo "The tunnel to $device_host did not come up; see $logs/tunnel.log" >&2
    exit 1
  fi
  sleep 2
done

# This checkout belongs to the script and only builds the native client, so the sync skips
# everything git ignores. Its lock spans clone, sync and build, so concurrent sessions never sync
# over a running build.
checkout="Developer/t3code-mobile-session"
echo "Installing the dev client on $device_host..." >&2
coproc lock {
  ssh "$device_host" "/usr/bin/lockf -k $checkout.lock /bin/sh -c '
    { test -d $checkout/.git || git clone -q git@git.schnau.dev:schnau/t3code.git $checkout; } &&
      echo locked && cat >/dev/null'"
}
read -r _ <&"${lock[0]}"
rsync -a --checksum --delete --filter=':- .gitignore' --exclude .git --exclude .jj --exclude node_modules \
  ./ "$device_host:$checkout/" >"$logs/sync.log" 2>&1
ssh "$device_host" "cd $checkout && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --trust-lockfile --network-concurrency 4 >&2 && PATH=\$PWD/node_modules/.bin:\$PATH builder-control run -- node scripts/mobile-native-client.ts ensure $platform $device" \
  >"$logs/install.json" 2>"$logs/install.log" &
children+=("$!")
wait "${children[-1]}"
exec {lock[1]}>&-
cat "$logs/install.json"

app_id="$(node --input-type=module -e '
const { developmentClientId } = await import(process.cwd() + "/scripts/lib/mobile-app-ids.ts");
const { loadRepoEnv } = await import(process.cwd() + "/scripts/lib/public-config.ts");
process.stdout.write(developmentClientId(process.argv[1], loadRepoEnv()));
' "$platform")"
dev_client_url="t3code-dev://expo-development-client/?url=$(node -p 'encodeURIComponent(process.argv[1])' "$metro_url")&disableOnboarding=1&disableFab=1&disableAutoLaunch=1"
retry "$agent_device_command" open "$app_id" "$dev_client_url" "${target_args[@]}" >/dev/null
# The app drops a pairing link that arrives before its JavaScript runs, and a cold bundle takes
# minutes to build and download.
echo "Waiting for the app to load from Metro..." >&2
wait_for_line "$logs/metro.log" "(iOS|Android) Bundled .* apps/mobile/index" "${children[1]}"
for ((attempt = 0; ; attempt++)); do
  screen="$("$agent_device_command" snapshot -i "${target_args[@]}" 2>/dev/null || true)"
  if grep -q '\[button\]' <<<"$screen" && ! grep -qE 'SplashScreenLogo|Bundling|Downloading' <<<"$screen"; then
    break
  fi
  if ((attempt >= 120)); then
    echo "The app did not finish loading within 10 minutes; see $logs/metro.log" >&2
    exit 1
  fi
  sleep 5
done
retry .agents/skills/test-t3-mobile/scripts/pair-client.sh \
  "$server_port" "$base_dir" "http://$origin_host:$server_port" "$agent_device_command" "${target_args[@]}"

cat <<EOF
Ready.
  backend  http://$origin_host:$server_port  (base dir $base_dir, log $logs/backend.log)
  metro    $metro_url  (log $logs/metro.log)
Stop this command to stop both.
EOF
wait
