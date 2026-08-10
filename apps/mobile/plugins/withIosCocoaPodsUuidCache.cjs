const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod } = require("expo/config-plugins");

const MARKER = "# t3code: repair cached CocoaPods UUID allocation before SPM integration";
const UUID_REPAIR = `${MARKER}
    pods_project = installer.pods_project
    existing_uuids = pods_project.objects.map(&:uuid)
    uuid_prefix = pods_project.instance_variable_get(:@uuid_prefix)[0, 6]
    sequential_uuid = /\\A#{Regexp.escape(uuid_prefix)}([0-9A-F]{7})0\\z/
    highest_index = existing_uuids.filter_map do |uuid|
      match = sequential_uuid.match(uuid)
      match && match[1].to_i(16)
    end.max || -1

    # Pod::Project generates sequential UUIDs without collision checks because CocoaPods
    # normally creates the project in this process. EAS can restore Pods.xcodeproj from
    # cache, leaving the allocator behind the loaded objects. React Native's SPM support
    # then reuses an existing UUID and silently corrupts the project graph.
    next_index = highest_index + 1
    pods_project.instance_variable_set(:@generated_uuids, Array.new(next_index))
    pods_project.instance_variable_set(:@available_uuids, [])
    pods_project.generate_available_uuid_list(1_000)
    Pod::UI.puts "T3Code: reset CocoaPods UUID allocator at #{next_index} (#{existing_uuids.length} existing objects)"

    # Xcode 27 rejects targets below iOS 15 instead of merely warning. A few
    # transitive pods still publish iOS 12 deployment targets, so normalize all
    # generated pod targets to the app's supported floor on every clean prebuild.
    minimum_ios_version = Gem::Version.new("18.0")
    pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        configured_version = build_configuration.build_settings["IPHONEOS_DEPLOYMENT_TARGET"]
        next if configured_version && Gem::Version.new(configured_version) >= minimum_ios_version
        build_configuration.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] = minimum_ios_version.to_s
      end
    end
`;

module.exports = function withIosCocoaPodsUuidCache(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");

      if (podfile.includes(MARKER)) {
        return nextConfig;
      }

      const postInstallStart = "post_install do |installer|\n";
      if (!podfile.includes(postInstallStart)) {
        throw new Error("Unable to repair CocoaPods UUID allocation: post_install is missing.");
      }

      fs.writeFileSync(
        podfilePath,
        podfile.replace(postInstallStart, `${postInstallStart}${UUID_REPAIR}`),
        "utf8",
      );
      return nextConfig;
    },
  ]);
};
