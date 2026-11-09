#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <server-port> <base-dir> <mobile-origin> <agent-device-command> <target-args...>" >&2
  exit 2
}

[[ $# -ge 5 ]] || usage

server_port="$1"
base_dir="$2"
mobile_origin="$3"
agent_device_command="$4"
shift 4

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

platform=""
target_args=("$@")
for ((i = 0; i + 1 < ${#target_args[@]}; i++)); do
  [[ "${target_args[i]}" == "--platform" ]] && platform="${target_args[i + 1]}"
done
if [[ "$platform" != ios && "$platform" != android ]]; then
  echo "Pass the AgentDevice target arguments, including --platform ios or --platform android." >&2
  exit 2
fi
app_id="$(node --input-type=module -e '
const { developmentClientId } = await import(process.cwd() + "/scripts/lib/mobile-app-ids.ts");
const { loadRepoEnv } = await import(process.cwd() + "/scripts/lib/public-config.ts");
process.stdout.write(developmentClientId(process.argv[1], loadRepoEnv()));
' "$platform")"

if ! pairing_output="$({
  T3CODE_PORT="$server_port" node apps/server/src/bin.ts auth pairing create \
    --base-dir "$base_dir" \
    --base-url "$mobile_origin" \
    --ttl 15m \
    --label "agent-mobile"
} 2>&1)"; then
  echo "Could not mint a mobile pairing credential." >&2
  exit 1
fi

pairing_url="$(printf '%s\n' "$pairing_output" | sed -n 's/^Pair URL: //p' | tail -n 1)"
pairing_id="$(printf '%s\n' "$pairing_output" | sed -n 's/^Issued client pairing token \(.*\)\.$/\1/p' | tail -n 1)"
if [[ -z "$pairing_url" || -z "$pairing_id" ]]; then
  echo "Could not parse the mobile pairing URL." >&2
  exit 1
fi

deep_link="$(PAIRING_URL="$pairing_url" node - <<'NODE'
const query = new URLSearchParams({
  pairingUrl: process.env.PAIRING_URL,
  autoConnect: "1",
});
process.stdout.write(`t3code-dev://connections/new?${query}`);
NODE
)"

if ! "$agent_device_command" open "$app_id" "$deep_link" "$@" \
  >/dev/null 2>&1; then
  echo "AgentDevice could not open the pairing route. Check the Device panel and retry with a fresh credential." >&2
  exit 1
fi

# A link that arrives while the app is still starting is dropped, so wait until the app used it.
# The auth CLI takes many seconds to start, so this reads the backend's database directly.
if node -e '
const { DatabaseSync } = require("node:sqlite");
const [file, id] = process.argv.slice(1);
const deadline = Date.now() + 30_000;
const consumed = () =>
  new DatabaseSync(file, { readOnly: true })
    .prepare("select consumed_at from auth_pairing_links where id = ?")
    .get(id)?.consumed_at;
const poll = () => (consumed() ? process.exit(0) : Date.now() > deadline ? process.exit(1) : setTimeout(poll, 1000));
poll();
' "$base_dir/userdata/statev2.sqlite" "$pairing_id"; then
  echo "Paired T3 Code Dev with the backend."
  exit 0
fi
T3CODE_PORT="$server_port" node apps/server/src/bin.ts auth pairing revoke --base-dir "$base_dir" "$pairing_id" >/dev/null 2>&1 || true
echo "T3 Code Dev did not use the pairing link within 30 seconds. Retry once the app shows its home screen." >&2
exit 1
