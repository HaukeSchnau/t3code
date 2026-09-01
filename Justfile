set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

mobile_device := env_var_or_default("T3CODE_IOS_DEVICE", "iPhone von Hauke")
apple_team_id := env_var_or_default("T3CODE_APPLE_TEAM_ID", "2243J9RD68")
desktop_output_dir := env_var_or_default("T3CODE_DESKTOP_INSTALL_OUTPUT_DIR", "release/local-desktop-install")
agent_device_session := env_var_or_default("T3CODE_AGENT_DEVICE_SESSION", "t3dev-physical")
agent_device_ios_bundle_id := env_var_or_default("T3CODE_AGENT_DEVICE_IOS_BUNDLE_ID", "dev.schnau.agentdevice.runner")

default:
    @just --list

# CI calls the individual tasks in parallel jobs. `just qa` remains the complete,
# resource-bounded local gate and deliberately runs the groups in order.
qa: qa-static qa-typecheck-clients qa-typecheck-rest qa-test-non-server qa-test-server qa-release

qa-static:
    ./node_modules/.bin/vp fmt --check
    ./node_modules/.bin/vp lint --report-unused-disable-directives --threads 1

qa-typecheck-clients:
    ./node_modules/.bin/vp run --cache --concurrency-limit 1 --filter @t3tools/web --filter @t3tools/mobile typecheck

qa-typecheck-rest:
    ./node_modules/.bin/vp run --filter @t3tools/desktop ensure:electron
    ./node_modules/.bin/vp run -r --cache --concurrency-limit 1 --filter '!@t3tools/web' --filter '!@t3tools/mobile' typecheck

qa-test-non-server:
    ./node_modules/.bin/vp run --filter @t3tools/desktop ensure:electron
    ./node_modules/.bin/vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' test

qa-test-server:
    ./node_modules/.bin/vp run --filter t3 test

qa-test-server-shard shard total:
    ./node_modules/.bin/vp run --filter t3 test --shard {{ quote(shard + "/" + total) }}

qa-release:
    node scripts/release-smoke.ts
    node scripts/fork-lockfile.ts --check

# Print the pnpmDeps SRI for flake.nix by forcing a fake-hash Nix build and extracting the "got" value.
prefetch-pnpm-deps:
    ./scripts/prefetch-pnpm-deps.sh

# Build and install the iOS development app on the configured device.
mobile-dev:
    just _mobile-ios development Debug T3CodeDev

# Build and install the bundled iOS production app on the configured device.
mobile-prod:
    just _mobile-ios production Release T3Code

# Start Metro for the iOS dev client. Pass a pairing URL to auto-fill and auto-connect the Add Environment screen.
mobile-dev-server pairing_url="":
    #!/usr/bin/env bash
    set -euo pipefail

    cd apps/mobile
    if [[ -n "{{ pairing_url }}" ]]; then
      EXPO_PUBLIC_T3CODE_DEV_PAIRING_URL="{{ pairing_url }}" \
        EXPO_PUBLIC_T3CODE_DEV_PAIRING_AUTOCONNECT=1 \
        bun run dev:client
    else
      bun run dev:client
    fi

# Open the iOS dev client on the configured physical device through agent-device.
mobile-dev-open metro_url="":
    #!/usr/bin/env bash
    set -euo pipefail

    resolved_metro_url="{{ metro_url }}"
    if [[ -z "$resolved_metro_url" ]]; then
      host="${T3CODE_MOBILE_METRO_HOST:-}"
      if [[ -z "$host" ]]; then
        host="$(ipconfig getifaddr en0 2>/dev/null || true)"
      fi
      if [[ -z "$host" ]]; then
        echo "Could not infer a LAN host for Metro. Set T3CODE_MOBILE_METRO_HOST or pass a Metro URL." >&2
        exit 1
      fi
      resolved_metro_url="http://$host:8081"
    fi

    encoded_url="$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$resolved_metro_url")"
    AGENT_DEVICE_IOS_TEAM_ID="{{ apple_team_id }}" \
      AGENT_DEVICE_IOS_BUNDLE_ID="{{ agent_device_ios_bundle_id }}" \
      agent-device \
        --session "{{ agent_device_session }}" \
        open "t3code-dev://expo-development-client/?url=$encoded_url" \
        --platform ios \
        --device "{{ mobile_device }}" \
        --target mobile

# Reload React Native through Metro for the configured physical-device agent-device session.
mobile-dev-reload:
    AGENT_DEVICE_IOS_TEAM_ID="{{ apple_team_id }}" \
      AGENT_DEVICE_IOS_BUNDLE_ID="{{ agent_device_ios_bundle_id }}" \
      agent-device \
        --session "{{ agent_device_session }}" \
        metro reload \
        --platform ios \
        --device "{{ mobile_device }}" \
        --target mobile

# Capture the current accessibility snapshot from the configured physical-device agent-device session.
mobile-dev-snapshot:
    AGENT_DEVICE_IOS_TEAM_ID="{{ apple_team_id }}" \
      AGENT_DEVICE_IOS_BUNDLE_ID="{{ agent_device_ios_bundle_id }}" \
      agent-device \
        --session "{{ agent_device_session }}" \
        snapshot \
        --platform ios \
        --device "{{ mobile_device }}" \
        --target mobile

# Build a macOS desktop DMG and install the contained app into /Applications.
desktop-macos:
    #!/usr/bin/env bash
    set -euo pipefail

    out_dir="{{ desktop_output_dir }}"
    rm -rf "$out_dir"
    mkdir -p "$out_dir"

    node scripts/build-desktop-artifact.ts --platform mac --target dmg --output-dir "$out_dir"

    dmg_path="$(find "$out_dir" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
    if [[ -z "$dmg_path" ]]; then
      echo "No DMG artifact was produced in $out_dir." >&2
      exit 1
    fi

    mount_dir="$(mktemp -d /tmp/t3code-desktop-dmg.XXXXXX)"
    cleanup() {
      hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
      rmdir "$mount_dir" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT

    hdiutil attach "$dmg_path" -mountpoint "$mount_dir" -nobrowse -quiet

    app_path="$(find "$mount_dir" -maxdepth 1 -type d -name '*.app' -print -quit)"
    if [[ -z "$app_path" ]]; then
      echo "No .app bundle was found in $dmg_path." >&2
      exit 1
    fi

    app_name="$(basename "$app_path")"
    if [[ "$app_name" != *.app ]]; then
      echo "Refusing to install unexpected app bundle name: $app_name" >&2
      exit 1
    fi

    install_path="/Applications/$app_name"
    rm -rf "$install_path"
    ditto "$app_path" "$install_path"
    echo "Installed $install_path"

_mobile-ios variant configuration scheme:
    #!/usr/bin/env bash
    set -euo pipefail

    device_name="{{ mobile_device }}"
    team_id="{{ apple_team_id }}"
    variant="{{ variant }}"
    configuration="{{ configuration }}"
    scheme="{{ scheme }}"
    derived_data_path="apps/mobile/ios/build/$scheme-$configuration"

    cd apps/mobile
    APP_VARIANT="$variant" EXPO_NO_GIT_STATUS=1 bunx expo prebuild --clean --platform ios
    cd ../..

    TEAM_ID="$team_id" node <<'NODE'
    const fs = require("node:fs");
    const path = require("node:path");

    const teamId = process.env.TEAM_ID;
    if (!teamId) {
      throw new Error("TEAM_ID is required.");
    }

    const projectPath = path.join(
      "apps",
      "mobile",
      "ios",
      "T3Code.xcodeproj",
      "project.pbxproj",
    );
    const altProjectPath = path.join(
      "apps",
      "mobile",
      "ios",
      "T3CodeDev.xcodeproj",
      "project.pbxproj",
    );
    const pbxprojPath = fs.existsSync(projectPath) ? projectPath : altProjectPath;
    let project = fs.readFileSync(pbxprojPath, "utf8");

    project = project.replace(/DevelopmentTeam = [A-Z0-9]+;/g, `DevelopmentTeam = ${teamId};`);
    if (!project.includes(`DevelopmentTeam = ${teamId};`)) {
      project = project.replace(
        /(TargetAttributes = \{\n\s+[A-Z0-9]+ = \{\n)/,
        `$1\t\t\t\t\t\tDevelopmentTeam = ${teamId};\n`,
      );
    }

    project = project.replace(
      /(buildSettings = \{\n)([\s\S]*?PRODUCT_BUNDLE_IDENTIFIER = [^;]+;[\s\S]*?)(\n\s+\};\n\s+name = (?:Debug|Release);)/g,
      (_match, start, body, end) => {
        const upsertSetting = (source, key, value) => {
          const settingPattern = new RegExp(`\\n\\s+${key} = [^;]+;`);
          if (settingPattern.test(source)) {
            return source.replace(settingPattern, `\n\t\t\t\t${key} = ${value};`);
          }
          return `\t\t\t\t${key} = ${value};\n${source}`;
        };

        let nextBody = upsertSetting(body, "CODE_SIGN_STYLE", "Automatic");
        nextBody = upsertSetting(nextBody, "DEVELOPMENT_TEAM", teamId);
        return `${start}${nextBody}${end}`;
      },
    );

    fs.writeFileSync(pbxprojPath, project);
    NODE

    device_identifier="$(
      xcrun devicectl list devices |
        awk -v name="$device_name" 'BEGIN { FS = "  +" } $1 == name { print $3; exit }'
    )"
    if [[ -z "$device_identifier" ]]; then
      echo "Could not find iOS device named '$device_name'." >&2
      xcrun devicectl list devices >&2
      exit 1
    fi

    rm -rf "$derived_data_path"
    xcodebuild \
      -quiet \
      -workspace "apps/mobile/ios/$scheme.xcworkspace" \
      -scheme "$scheme" \
      -configuration "$configuration" \
      -destination "platform=iOS,name=$device_name" \
      -derivedDataPath "$derived_data_path" \
      DEVELOPMENT_TEAM="$team_id" \
      CODE_SIGN_STYLE=Automatic \
      build

    app_path="$derived_data_path/Build/Products/$configuration-iphoneos/$scheme.app"
    if [[ ! -d "$app_path" ]]; then
      echo "Built app bundle was not found at $app_path." >&2
      exit 1
    fi

    xcrun devicectl device install app --device "$device_identifier" "$app_path"
