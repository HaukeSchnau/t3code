{
  description = "T3 Code development shell, package, and NixOS service";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-infra-modules = {
      url = "git+https://git.schnau.dev/schnau/nix-infra-modules.git?rev=7e0a8f95263cff6423576f26982535a408fe116e";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nix-infra-modules,
    }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = lib.genAttrs systems;

      packageJson = builtins.fromJSON (builtins.readFile ./apps/server/package.json);
      projectDescriptor = builtins.fromJSON (builtins.readFile ./project.json);
      normalizedProjectDescriptor = nix-infra-modules.lib.projectDescriptor.normalize {
        descriptor = projectDescriptor;
        expectedProject = "t3code";
      };

      mkPkgs =
        system:
        import nixpkgs {
          inherit system;
        };

      mkPnpm =
        pkgs: nodejs:
        (pkgs.pnpm_11.override { inherit nodejs; }).overrideAttrs {
          version = "11.10.0";
          src = pkgs.fetchurl {
            url = "https://registry.npmjs.org/pnpm/-/pnpm-11.10.0.tgz";
            hash = "sha256-YgtmBepPYvxWptCphzP0eQcdAyHgPkhrUix+mnRhdDE=";
          };
        };

      mkT3CodePackageWith =
        {
          pkgs,
          preferLocalWebBuild ? false,
        }:
        let
          nodejs = pkgs.nodejs_24;
          pnpm = mkPnpm pkgs nodejs;
          installFlags = [ "--ignore-scripts" ];

          manifestFiles = lib.fileset.unions [
            ./package.json
            ./pnpm-deploy-lock.yaml
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            (lib.fileset.fileFilter (file: lib.hasSuffix ".patch" file.name) ./patches)
            ./apps/server/package.json
            ./apps/web/package.json
            (lib.fileset.fileFilter (file: file.name == "package.json") ./packages)
          ];
          productionFiles =
            path:
            lib.fileset.fileFilter (
              file:
              file.type == "directory"
              || (
                file.name != "vitest.config.ts"
                && !lib.hasSuffix ".test.ts" file.name
                && !lib.hasSuffix ".test.tsx" file.name
              )
            ) path;
          manifestSource = lib.fileset.toSource {
            root = ./.;
            fileset = manifestFiles;
          };
          webSource = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              manifestFiles
              ./tsconfig.base.json
              (productionFiles ./apps/web)
              (productionFiles ./packages/client-runtime)
              (productionFiles ./packages/contracts)
              (productionFiles ./packages/shared)
              ./scripts/lib/public-config.ts
            ];
          };
          serverSource = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              manifestFiles
              ./tsconfig.base.json
              (productionFiles ./apps/server)
              (productionFiles ./packages/client-runtime)
              (productionFiles ./packages/contracts)
              (productionFiles ./packages/effect-acp)
              (productionFiles ./packages/effect-codex-app-server)
              (productionFiles ./packages/shared)
              (productionFiles ./packages/tailscale)
              ./scripts/lib/cli-external-packages.ts
              ./scripts/lib/public-config.ts
            ];
          };

          mkPnpmDeps =
            {
              pname,
              src,
              workspaces,
              hash,
              prePnpmInstall ? "",
            }:
            pkgs.fetchPnpmDeps {
              inherit
                pname
                src
                pnpm
                hash
                prePnpmInstall
                ;
              version = packageJson.version;
              fetcherVersion = 4;
              pnpmWorkspaces = workspaces;
              pnpmInstallFlags = installFlags;
            };

          webPnpmDeps = mkPnpmDeps {
            pname = "t3code-web-deps";
            src = manifestSource;
            workspaces = [ "@t3tools/web..." ];
            hash = "sha256-1Y2H5xARIrZNmeMiEpYr7hF1RA12yOeYMDU1+WuoKug=";
          };
          serverPnpmDeps = mkPnpmDeps {
            pname = "t3code-server-deps";
            src = manifestSource;
            workspaces = [ "t3..." ];
            hash = "sha256-wWrsBoU8MwEu/J5u2afJqBvoytC56nViYTci5xMS34I=";
          };
          runtimePnpmDeps = mkPnpmDeps {
            pname = "t3code-runtime-deps";
            src = manifestSource;
            workspaces = [ "t3" ];
            prePnpmInstall = ''
              cp pnpm-deploy-lock.yaml pnpm-lock.yaml
              printf '\ninjectWorkspacePackages: true\n' >> pnpm-workspace.yaml
            '';
            hash = "sha256-r4CX8KEmgjfUzjqOS+h9g/Oze8ZWx9RCTP/kSBJNbqI=";
          };

          commonNativeBuildInputs = [
            nodejs
            pkgs.pnpmConfigHook
            pnpm
          ];
          commonEnv = {
            NODE_EXTRA_CA_CERTS = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
            SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
            pnpm_config_trust_lockfile = "true";
          };

          web = pkgs.stdenv.mkDerivation {
            pname = "t3code-web";
            version = packageJson.version;
            preferLocalBuild = preferLocalWebBuild;
            src = webSource;
            pnpmDeps = webPnpmDeps;
            pnpmWorkspaces = [ "@t3tools/web..." ];
            pnpmInstallFlags = installFlags;
            nativeBuildInputs = commonNativeBuildInputs;
            env = commonEnv // {
              T3CODE_WEB_SOURCEMAP = "false";
            };
            buildPhase = ''
              runHook preBuild
              pnpm --filter @t3tools/web build
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              cp -R apps/web/dist "$out"
              runHook postInstall
            '';
          };

          server = pkgs.stdenv.mkDerivation {
            pname = "t3code-server";
            version = packageJson.version;
            src = serverSource;
            pnpmDeps = serverPnpmDeps;
            pnpmWorkspaces = [ "t3..." ];
            pnpmInstallFlags = installFlags;
            nativeBuildInputs = commonNativeBuildInputs;
            env = commonEnv // {
              T3CODE_SERVER_SOURCEMAP = "false";
            };
            buildPhase = ''
              runHook preBuild
              pnpm --filter t3 build:bundle
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp apps/server/package.json "$out/package.json"
              cp -R apps/server/dist "$out/dist"
              runHook postInstall
            '';
          };

          runtimeDependencies = pkgs.stdenv.mkDerivation {
            pname = "t3code-runtime-dependencies";
            version = packageJson.version;
            src = manifestSource;
            pnpmDeps = runtimePnpmDeps;
            pnpmWorkspaces = [ "t3" ];
            pnpmInstallFlags = installFlags;
            nativeBuildInputs = [
              nodejs
              pnpm
              pkgs.pkg-config
              pkgs.python3
              pkgs.sqlite
              pkgs.zstd
            ];
            buildInputs = [ nodejs ];
            env = commonEnv // {
              npm_config_nodedir = nodejs;
            };
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              runHook preInstall
              export STORE_PATH="$(mktemp -d)"
              tar --zstd -xf "${runtimePnpmDeps}/pnpm-store.tar.zst" -C "$STORE_PATH"
              chmod -R +w "$STORE_PATH"
              if [ -f "$STORE_PATH/v11/index.db.sql" ]; then
                sqlite3 "$STORE_PATH/v11/index.db" < "$STORE_PATH/v11/index.db.sql"
                rm "$STORE_PATH/v11/index.db.sql"
              fi
              export pnpm_config_store_dir="$STORE_PATH"
              cp pnpm-deploy-lock.yaml pnpm-lock.yaml
              printf '\ninjectWorkspacePackages: true\n' >> pnpm-workspace.yaml
              mkdir -p apps/server/dist
              pnpm_config_ignore_scripts=true pnpm --offline --frozen-lockfile --filter t3 --prod deploy "$out"
              npm_config_build_from_source=true pnpm --dir "$out" rebuild node-pty
              find "$out/node_modules" -type d -path "*/node-pty@*/node_modules/node-pty/prebuilds" -prune -exec rm -rf {} +
              find "$out/node_modules/.pnpm" -type f \
                -path "*/node-pty@*/node_modules/node-pty/build/*" \
                \( -name "*Makefile" -o -name "*.mk" -o -name config.gypi \) \
                -delete
              find "$out/node_modules/.pnpm" -type d \
                -path "*/node-pty@*/node_modules/node-pty/build/*" \
                -empty -delete
              rm -rf "$out/dist"
              runHook postInstall
            '';
          };

          runtimePath = lib.makeBinPath (
            [
              pkgs.bash
              pkgs.coreutils
              pkgs.curl
              pkgs.findutils
              pkgs.git
              pkgs.gnugrep
              pkgs.gnused
              pkgs.jujutsu
              pkgs.openssh
              pkgs.which
            ]
            ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.procps
            ]
          );
        in
        pkgs.runCommand "t3code-${packageJson.version}"
          {
            nativeBuildInputs = [ pkgs.makeWrapper ];
            passthru = {
              inherit web server runtimeDependencies;
            };
            meta = {
              description = "Minimal web GUI for using coding agents like Codex and Claude";
              homepage = "https://github.com/pingdotgg/t3code";
              license = lib.licenses.mit;
              mainProgram = "t3";
              platforms = lib.platforms.unix;
            };
          }
          ''
            mkdir -p "$out/lib/t3code/dist" "$out/bin"
            cp ${server}/package.json "$out/lib/t3code/package.json"
            cp -R ${server}/dist/. "$out/lib/t3code/dist/"
            ln -s ${web} "$out/lib/t3code/dist/client"
            ln -s ${runtimeDependencies}/node_modules "$out/lib/t3code/node_modules"
            makeWrapper "${nodejs}/bin/node" "$out/bin/t3" \
              --add-flags "$out/lib/t3code/dist/bin.mjs" \
              --suffix PATH : "${runtimePath}" \
              --set-default NODE_ENV production
          '';

      mkT3CodePackage = pkgs: mkT3CodePackageWith { inherit pkgs; };

      mkProjectRuntime =
        system:
        let
          pkgs = mkPkgs system;
          nodejs = pkgs.nodejs_24;
          pnpm = mkPnpm pkgs nodejs;

          prepareAction = pkgs.writeShellApplication {
            name = "t3code-project-prepare";
            runtimeInputs = [
              nodejs
              pkgs.coreutils
              pkgs.findutils
              pkgs.gcc
              pkgs.git
              pkgs.gnumake
              pkgs.gnugrep
              pkgs.gnused
              pkgs.pkg-config
              pkgs.python3
              pnpm
            ];
            text = ''
              checkout="$(project-context path checkout)"
              cache_root="$(project-context path cache)"
              preparation_state="$cache_root/preparation"
              stamp_file="$preparation_state/dependencies.sha256"
              cd "$checkout"

              dependency_key=$(
                {
                  sha256sum flake.lock package.json pnpm-lock.yaml pnpm-workspace.yaml
                  find apps packages -type f -name package.json -print0 \
                    | sort -z \
                    | xargs -0 -r sha256sum
                  if [[ -d patches ]]; then
                    find patches -type f -name '*.patch' -print0 \
                      | sort -z \
                      | xargs -0 -r sha256sum
                  fi
                } | sha256sum | cut -d ' ' -f 1
              )

              if [[ -d node_modules && -f "$stamp_file" ]] \
                && [[ "$(<"$stamp_file")" == "$dependency_key" ]]; then
                echo "T3 Code dependencies are already prepared ($dependency_key)"
                exit 0
              fi

              export npm_config_nodedir="${nodejs}"
              pnpm install --frozen-lockfile
              install -d -m 0700 "$preparation_state"
              printf '%s\n' "$dependency_key" > "$stamp_file.next"
              mv "$stamp_file.next" "$stamp_file"
            '';
          };

          webAction = pkgs.writeShellApplication {
            name = "t3code-project-web";
            runtimeInputs = [
              nodejs
              pkgs.coreutils
              pkgs.git
            ];
            text = ''
              web_url="$(project-context endpoint web url)"
              web_host="$(project-context endpoint web listen-host)"
              web_port="$(project-context endpoint web listen-port)"
              web_host_names="$(project-context endpoint web host-names --json)"
              allowed_hosts="$(
                node -e 'process.stdout.write(JSON.parse(process.argv[1]).join(","))' "$web_host_names"
              )"
              checkout="$(project-context path checkout)"
              state_root="$(project-context path state)"
              cache_root="$(project-context path cache)"
              t3_home="$state_root/t3-home"
              web_cache="$cache_root/web"
              install -d -m 0700 "$t3_home" "$web_cache"

              export XDG_CACHE_HOME="$web_cache"
              export PATH="$checkout/node_modules/.bin:$PATH"
              export T3CODE_BUNDLED_DEV=1
              export T3CODE_DEV_ALLOWED_HOSTS="$allowed_hosts"
              unset AGENT_SERVICE_PORT AGENT_SERVICE_URL T3CODE_HOST T3CODE_PORT

              cd "$checkout"
              exec node scripts/dev-runner.ts dev \
                --no-browser \
                --host 127.0.0.1 \
                --home-dir "$t3_home" \
                --web-host "$web_host" \
                --web-port "$web_port" \
                --dev-url "$web_url"
            '';
          };

          mobileAction = pkgs.writeShellApplication {
            name = "t3code-project-mobile";
            runtimeInputs = [
              nodejs
              pkgs.coreutils
              pnpm
            ];
            text = ''
              mobile_url="$(project-context endpoint mobile url)"
              mobile_port="$(project-context endpoint mobile listen-port)"
              checkout="$(project-context path checkout)"
              cache_root="$(project-context path cache)"
              mobile_cache="$cache_root/mobile"
              install -d -m 0700 "$mobile_cache/tmp"

              export APP_VARIANT=development
              export EXPO_PACKAGER_PROXY_URL="$mobile_url"
              export EXPO_UNSTABLE_HEADLESS=1
              export NODE_OPTIONS="--dns-result-order=ipv4first''${NODE_OPTIONS:+ $NODE_OPTIONS}"
              export TMPDIR="$mobile_cache/tmp"
              export XDG_CACHE_HOME="$mobile_cache"

              encoded_url="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$mobile_url")"
              echo "T3 Code Dev Client: t3code-dev://expo-development-client/?url=$encoded_url"

              cd "$checkout/apps/mobile"
              exec pnpm exec expo start \
                --dev-client \
                --scheme t3code-dev \
                --localhost \
                --port "$mobile_port"
            '';
          };
        in
        nix-infra-modules.lib.projectRuntime.mkDevelopment {
          inherit pkgs;
          descriptorPath = ./project.json;
          actions = {
            prepare = lib.getExe prepareAction;
            web = lib.getExe webAction;
            mobile = lib.getExe mobileAction;
          };
        };

      projectRuntimes = forAllSystems mkProjectRuntime;

      mkProjectRelease =
        system:
        let
          pkgs = mkPkgs system;
          package = mkT3CodePackage pkgs;
          runtimeIdentity = ''
            export HOME CODEX_HOME T3CODE_HOME
            HOME="$(project-context parameter homeDirectory)"
            CODEX_HOME="$(project-context parameter codexHome)"
            T3CODE_HOME="$(project-context parameter t3Home)"
          '';
          webEnvironment = ''
            ${runtimeIdentity}
            export T3CODE_APNS_KEY_ID T3CODE_APNS_PRIVATE_KEY_FILE T3CODE_APNS_TEAM_ID
            T3CODE_APNS_KEY_ID="$(project-context parameter apnsKeyId)"
            T3CODE_APNS_PRIVATE_KEY_FILE="$(project-context secret-file apnsPrivateKey --required)"
            T3CODE_APNS_TEAM_ID="$(project-context parameter apnsTeamId)"
            export T3CODE_OTLP_METRICS_URL T3CODE_OTLP_SERVICE_NAME
            T3CODE_OTLP_METRICS_URL="$(project-context parameter otlpMetricsUrl)"
            T3CODE_OTLP_SERVICE_NAME="$(project-context parameter otlpServiceName)"
          '';
          webAction = pkgs.writeShellApplication {
            name = "t3code-release-web";
            text = ''
              ${webEnvironment}
              host="$(project-context endpoint web listen-host)"
              port="$(project-context endpoint web listen-port)"
              cd "$HOME"
              exec ${lib.getExe package} serve \
                --host "$host" \
                --port "$port" \
                --base-dir "$T3CODE_HOME" \
                "$HOME"
            '';
          };
          idleAction = pkgs.writeShellApplication {
            name = "t3code-release-idle";
            text = ''
              ${runtimeIdentity}
              exec ${lib.getExe package} status idle \
                --base-dir "$T3CODE_HOME" \
                --quiet
            '';
          };
        in
        nix-infra-modules.lib.projectRuntime.mkServiceRelease {
          inherit pkgs;
          descriptorPath = ./project.json;
          payloads = [ package ];
          actions = {
            web = webAction;
            idle = idleAction;
          };
        };

      projectReleases = forAllSystems mkProjectRelease;
    in
    {
      lib = {
        inherit mkT3CodePackage mkT3CodePackageWith;
        project = projectDescriptor;
      };

      packages = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
        in
        rec {
          t3code = mkT3CodePackage pkgs;
          default = t3code;
          projectRuntime = projectRuntimes.${system}.package;
          projectRelease = projectReleases.${system}.package;
        }
      );

      apps = forAllSystems (
        system:
        let
          projectRuntime = projectRuntimes.${system};
        in
        {
          t3 = {
            type = "app";
            program = "${self.packages.${system}.t3code}/bin/t3";
            meta.description = "Run the T3 Code server CLI";
          };
        }
        // projectRuntime.apps
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
          nodejs = pkgs.nodejs_24;
          pnpm = mkPnpm pkgs nodejs;
        in
        {
          default = pkgs.mkShell {
            packages = [
              nodejs
              pnpm
              pkgs.git
              pkgs.jujutsu
              pkgs.openssh
              pkgs.pkg-config
              pkgs.python3
            ];

            shellHook = ''
              export npm_config_nodedir="${nodejs}"
            '';
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
          runtime = projectRuntimes.${system};
          release = projectReleases.${system};
        in
        {
          package = self.packages.${system}.default;
          projectDescriptor =
            assert
              builtins.attrNames normalizedProjectDescriptor.development.workloads == [
                "mobile"
                "web"
              ];
            assert normalizedProjectDescriptor.development.workloads.mobile.action == "mobile";
            assert normalizedProjectDescriptor.development.workloads.web.action == "web";
            assert
              builtins.attrNames normalizedProjectDescriptor.development.endpoints == [
                "mobile"
                "web"
              ];
            assert normalizedProjectDescriptor.development.endpoints.mobile.health.paths == [ "/status" ];
            assert normalizedProjectDescriptor.development.endpoints.web.health.paths == [ "/" ];
            assert normalizedProjectDescriptor.development.endpoints.web.health.startupTimeoutSec == 300;
            assert normalizedProjectDescriptor.development.endpoints.web.health.requestTimeoutSec == 300;
            assert normalizedProjectDescriptor.release.package == "projectRelease";
            assert normalizedProjectDescriptor.release.executable == "project-release-runtime";
            assert normalizedProjectDescriptor.release.action == "web";
            assert normalizedProjectDescriptor.release.health.paths == [ "/" ];
            assert normalizedProjectDescriptor.release.preDeployTasks.wait-for-idle.failureMode == "defer";
            assert normalizedProjectDescriptor.release.ingress.streamCloseDelaySec == 300;
            pkgs.runCommand "t3code-project-descriptor-check" { } ''
              touch "$out"
            '';
          projectRuntimeInterface = runtime.checks.interface;
          projectReleaseInterface = release.checks.interface;
          projectReleaseDescriptor = release.checks.descriptorExact;
          projectReleaseGate = pkgs.runCommand "t3code-project-release-gate" { } ''
            test -x ${release.package}/bin/project-release-runtime
            test -f ${release.package}/share/project/descriptor.json
            touch "$out"
          '';
        }
      );

      nixosModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.t3code;
        in
        {
          options.services.t3code = {
            enable = lib.mkEnableOption "the T3 Code server";

            package = lib.mkPackageOption self.packages.${pkgs.stdenv.hostPlatform.system} "t3code" {
              default = "default";
            };

            user = lib.mkOption {
              type = lib.types.str;
              default = "t3code";
              description = "User account that runs the T3 Code server.";
            };

            group = lib.mkOption {
              type = lib.types.str;
              default = "t3code";
              description = "Group account that runs the T3 Code server.";
            };

            createUser = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Whether to create the configured service user and group.";
            };

            baseDir = lib.mkOption {
              type = lib.types.path;
              default = "/var/lib/t3code";
              description = "Persistent T3CODE_HOME directory.";
            };

            createBaseDir = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Whether to create the persistent T3CODE_HOME directory with tmpfiles.";
            };

            cwd = lib.mkOption {
              type = lib.types.path;
              default = "/var/lib/t3code/projects/default";
              description = "Default working directory for provider sessions.";
            };

            createCwd = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Whether to create the default working directory with tmpfiles.";
            };

            host = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1";
              description = "Host/interface for the HTTP and WebSocket server.";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 3773;
              description = "Port for the HTTP and WebSocket server.";
            };

            openFirewall = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Open the configured TCP port in the NixOS firewall.";
            };

            environment = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = "Additional environment variables for the service.";
            };

            providerPackages = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = [ ];
              example = lib.literalExpression "[ pkgs.codex pkgs.claude-code ]";
              description = "Additional agent/provider CLI packages made available on PATH.";
            };

            extraArgs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Extra arguments passed to `t3 serve` before the cwd argument.";
            };
          };

          config = lib.mkIf cfg.enable {
            users.groups = lib.mkIf cfg.createUser {
              ${cfg.group} = { };
            };

            users.users = lib.mkIf cfg.createUser {
              ${cfg.user} = {
                isSystemUser = true;
                group = cfg.group;
                home = toString cfg.baseDir;
                createHome = true;
              };
            };

            systemd.tmpfiles.rules =
              lib.optionals cfg.createBaseDir [
                "d ${toString cfg.baseDir} 0750 ${cfg.user} ${cfg.group} -"
              ]
              ++ lib.optionals cfg.createCwd [
                "d ${toString cfg.cwd} 0750 ${cfg.user} ${cfg.group} -"
              ];

            systemd.services.t3code = {
              description = "T3 Code server";
              documentation = [ "https://github.com/pingdotgg/t3code" ];
              wantedBy = [ "multi-user.target" ];
              wants = [ "network-online.target" ];
              after = [ "network-online.target" ];

              path = [
                cfg.package
                pkgs.git
                pkgs.jujutsu
                pkgs.openssh
              ]
              ++ cfg.providerPackages;

              environment = {
                T3CODE_HOME = toString cfg.baseDir;
                T3CODE_HOST = cfg.host;
                T3CODE_PORT = toString cfg.port;
                T3CODE_NO_BROWSER = "1";
              }
              // cfg.environment;

              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Group = cfg.group;
                WorkingDirectory = toString cfg.cwd;
                ExecStart = lib.escapeShellArgs (
                  [
                    "${cfg.package}/bin/t3"
                    "serve"
                    "--host"
                    cfg.host
                    "--port"
                    (toString cfg.port)
                    "--base-dir"
                    (toString cfg.baseDir)
                  ]
                  ++ cfg.extraArgs
                  ++ [ (toString cfg.cwd) ]
                );
                Restart = "on-failure";
                RestartSec = "5s";
                StateDirectory = "t3code";
                StateDirectoryMode = "0750";
                UMask = "0077";
              };
            };

            networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
          };
        };
    };
}
