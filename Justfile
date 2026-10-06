set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

mobile_device := env_var_or_default("T3CODE_IOS_DEVICE", "iPhone von Hauke")
apple_team_id := env_var_or_default("T3CODE_APPLE_TEAM_ID", "2243J9RD68")
agent_device_session := env_var_or_default("T3CODE_AGENT_DEVICE_SESSION", "t3dev-physical")
non_server_test_workers := env_var_or_default("T3CODE_NON_SERVER_TEST_WORKERS", "3")
agent_device_ios_bundle_id := env_var_or_default("T3CODE_AGENT_DEVICE_IOS_BUNDLE_ID", "dev.schnau.agentdevice.runner")

default:
    @just --list

# CI calls the individual tasks in parallel jobs. `just qa` remains the complete,
# resource-bounded local gate and deliberately runs the groups in order.
qa: qa-nix-deps qa-static qa-typecheck-clients qa-typecheck-rest qa-test-non-server qa-test-server qa-release

qa-static:
    ./node_modules/.bin/vp fmt --check
    ./node_modules/.bin/vp lint --report-unused-disable-directives --threads 1

qa-typecheck-clients:
    ./node_modules/.bin/vp run --cache --concurrency-limit 1 --filter @t3tools/web --filter @t3tools/mobile typecheck

qa-typecheck-rest:
    ./node_modules/.bin/vp run --filter @t3tools/desktop ensure:electron
    ./node_modules/.bin/vp run --cache --concurrency-limit 1 --filter './apps/*' --filter './packages/*' --filter './infra/*' --filter './scripts' --filter './oxlint-plugin-t3code' --filter '!@t3tools/web' --filter '!@t3tools/mobile' typecheck

qa-test-non-server:
    ./node_modules/.bin/vp run --filter @t3tools/desktop ensure:electron
    ./node_modules/.bin/vp run --cache --parallel --concurrency-limit 1 --filter '!t3' --filter '!@t3tools/monorepo' --filter '!@t3tools/desktop' test --maxWorkers {{ quote(non_server_test_workers) }}
    cd apps/desktop && ../../node_modules/.bin/vp test run --passWithNoTests --maxWorkers {{ quote(non_server_test_workers) }}

qa-test-server:
    cd apps/server && ../../node_modules/.bin/vp test run

qa-test-server-shard shard total:
    cd apps/server && ../../node_modules/.bin/vp test run --reporter verbose --shard {{ quote(shard + "/" + total) }}

qa-release:
    node scripts/release-smoke.ts
    node scripts/fork-lockfile.ts --check
    node scripts/sync-pnpm-deploy-lock.mjs --check

qa-nix-deps:
    ./node_modules/.bin/vp run --workspace-root deps:nix-check

# Refresh all filtered pnpm stores and verify the release contract.
deps-nix-refresh:
    ./node_modules/.bin/vp run --workspace-root deps:nix-refresh

# Compatibility alias for the old task name.
prefetch-pnpm-deps: deps-nix-refresh

# Follow CI for the newest descendant of a revision on origin/main.
ci-watch revision="main@origin":
    ./node_modules/.bin/vp run --workspace-root ci:watch -- --revision {{ quote(revision) }}

# Publish the mobile JavaScript bundle as an OTA update. Entry point for Kiln's mobile-update step;
# leaves the runtime version in mobile-runtime-version for the TestFlight step on the Apple builder.
ci-mobile-update:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${T3CODE_MOBILE_UPDATES_DIR:?The host must provide a writable update directory.}"
    runtime_version="$(node scripts/mobile-update.ts runtime-version --updates-url "$T3CODE_MOBILE_UPDATES_URL")"
    printf '%s\n' "$runtime_version" > mobile-runtime-version
    node scripts/mobile-update.ts publish \
      --updates-url "$T3CODE_MOBILE_UPDATES_URL" \
      --runtime-version "$runtime_version" \
      --updates-dir "$T3CODE_MOBILE_UPDATES_DIR"

# Upload a TestFlight build when the runtime in `runtime_file` has none yet. Entry point for Kiln's
# testflight step on the Apple builder, which provides Xcode, CocoaPods, Node and the App Store
# Connect key; this flake's pinned Node and CocoaPods misbehave on macOS 27.
ci-mobile-testflight runtime_file: _apple-install
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/mobile-testflight.ts \
      --runtime-version "$(cat {{ quote(runtime_file) }})" \
      --updates-url "$T3CODE_MOBILE_UPDATES_URL" \
      --notes "$(git log -1 --format=%s)"

# Package and sign the macOS desktop app into desktop-release. Entry point for Kiln's
# desktop-package step on the Apple builder.
ci-desktop-package: _apple-install
    #!/usr/bin/env bash
    set -euo pipefail
    # electron-updater only installs a strictly higher version.
    base_version="$(node -p "require('./apps/desktop/package.json').version")"
    node scripts/update-release-package-versions.ts "${base_version}-schnau.$(date +%s)"
    # Urbs UG's Apple Development identity in the builder's login keychain. The team-based
    # designated requirement keeps updates and macOS permissions working when it is replaced.
    export CSC_NAME="Apple Development: Created via API (85N8Y9CZC4)" T3CODE_APPLE_TEAM_ID=2243J9RD68
    export T3CODE_DESKTOP_UPDATE_URL=https://t3code-updates.schnau.dev/desktop
    export PATH="$PWD/node_modules/.bin:/run/current-system/sw/bin:$PATH"
    rm -rf desktop-release
    # Rust comes from the builder's own pinned nixpkgs registry entry.
    nix shell nixpkgs#cargo nixpkgs#rustc --command \
      node scripts/build-desktop-artifact.ts --platform mac --target zip --arch arm64 --signed --output-dir desktop-release
    # Only what the update feed serves leaves the builder.
    find desktop-release -mindepth 1 -maxdepth 1 \
      ! -name '*-arm64.zip' ! -name '*-arm64.zip.blockmap' ! -name latest-mac.yml -exec rm -rf {} +

# The Apple builder sits behind a slow home uplink; pnpm's 60 s default aborts large tarballs when
# many download at once.
_apple-install:
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm_config_fetch_timeout=600000 \
      corepack pnpm install --frozen-lockfile --trust-lockfile --network-concurrency 4

# Publish the desktop build in `artifacts_dir` to the update feed. Entry point for Kiln's
# desktop-publish step.
ci-desktop-publish artifacts_dir commit=env("KILN_REVISION"):
    #!/usr/bin/env bash
    set -euo pipefail
    : "${T3CODE_DESKTOP_UPDATES_DIR:?The host must provide a writable desktop update directory.}"
    # Release notes list the first-parent commits since the previous build.
    git fetch -q --no-tags --depth=100 origin {{ quote(commit) }} || true
    node scripts/desktop-publish.ts \
      --artifacts-dir {{ quote(artifacts_dir) }} \
      --updates-dir "$T3CODE_DESKTOP_UPDATES_DIR" \
      --commit {{ quote(commit) }} \
      --repo "$PWD"

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

# Install the newest CI build of the macOS desktop app. Signed builds keep their permissions and
# update themselves; see patches/desktop-distribution.md.
desktop-macos:
    curl -fsSL https://t3code-updates.schnau.dev/desktop/install.sh | sh

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
