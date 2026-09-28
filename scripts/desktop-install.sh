#!/bin/sh
# Installs the newest T3 Code Schnau build from the fork's desktop update feed
# (patches/desktop-distribution.md). The app updates itself afterwards; rerun this
# to recover from a broken install.
#
#   curl -fsSL https://t3code-updates.schnau.dev/desktop/install.sh | sh
set -eu

feed="${T3CODE_DESKTOP_FEED:-https://t3code-updates.schnau.dev/desktop}"
app_name="T3 Code Schnau"
bundle_id="dev.schnau.t3code.desktop"
team_id="2243J9RD68"
target="/Applications/$app_name.app"

fail() {
  echo "$*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || fail "This build needs an Apple Silicon Mac."

work="$(mktemp -d /tmp/t3code-install.XXXXXX)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "$feed/latest-mac.yml" -o "$work/latest-mac.yml" || fail "Could not reach $feed. Is this Mac on the Tailnet?"
version="$(sed -n "s/^version: *'\{0,1\}\([^']*\)'\{0,1\}\$/\1/p" "$work/latest-mac.yml")"
zip="$(awk '/^  - url: .*-arm64\.zip$/ { print $3; exit }' "$work/latest-mac.yml")"
sha512="$(awk '/^  - url: .*-arm64\.zip$/ { found = 1; next } found && /sha512:/ { print $2; exit }' "$work/latest-mac.yml")"
[ -n "$version" ] && [ -n "$zip" ] && [ -n "$sha512" ] || fail "The feed does not list an arm64 build."

echo "Downloading $app_name $version"
curl -fL --progress-bar "$feed/$zip" -o "$work/app.zip"
actual="$(shasum -a 512 -b "$work/app.zip" | awk '{ print $1 }' | xxd -r -p | base64)"
[ "$actual" = "$sha512" ] || fail "Checksum mismatch for $zip."

ditto -x -k "$work/app.zip" "$work/unpacked"
app="$work/unpacked/$app_name.app"
[ -d "$app" ] || fail "$zip does not contain $app_name.app."
codesign --verify --deep --strict "$app" || fail "$app_name.app is not validly signed."
signature="$(codesign -dv "$app" 2>&1)"
echo "$signature" | grep -qx "Identifier=$bundle_id" || fail "Unexpected bundle identifier."
echo "$signature" | grep -qx "TeamIdentifier=$team_id" || fail "$app_name.app is not signed by team $team_id."

# Quit running copies, including the unsigned local build this app replaces, so
# only one app serves ~/.t3 at a time.
for running in "$app_name:$bundle_id" "T3 Code (Alpha):com.t3tools.t3code"; do
  name="${running%%:*}"
  if pgrep -xq "$name"; then
    echo "Quitting $name"
    osascript -e "tell application id \"${running#*:}\" to quit" >/dev/null 2>&1 || true
    tries=0
    while pgrep -xq "$name"; do
      tries=$((tries + 1))
      [ "$tries" -le 60 ] || fail "$name did not quit. Quit it and run this again."
      sleep 0.5
    done
  fi
done

rm -rf "$target.new"
ditto "$app" "$target.new"
rm -rf "$target"
mv "$target.new" "$target"
echo "Installed $target ($version)"

if [ -d "/Applications/T3 Code (Alpha).app" ]; then
  echo "The old T3 Code (Alpha).app is still in /Applications. Delete it once the new app shows your threads."
fi
open "$target"
