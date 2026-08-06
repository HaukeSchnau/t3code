{
  description = "T3 Code development shell, package, and NixOS service";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
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

      mkT3CodePackage =
        pkgs:
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
            hash = "sha256-+gmEAMECn6/GNiHiUCpDUQjaRusUerDXDxZ50J5GuWM=";
          };
          serverPnpmDeps = mkPnpmDeps {
            pname = "t3code-server-deps";
            src = manifestSource;
            workspaces = [ "t3..." ];
            hash = "sha256-t9FaJ9oHnfFjcPmSSB7vv1IVkdlfRAEb+hIGMpevpTA=";
          };
          runtimePnpmDeps = mkPnpmDeps {
            pname = "t3code-runtime-deps";
            src = manifestSource;
            workspaces = [ "t3" ];
            prePnpmInstall = ''
              cp pnpm-deploy-lock.yaml pnpm-lock.yaml
              printf '\ninjectWorkspacePackages: true\n' >> pnpm-workspace.yaml
            '';
            hash = "sha256-u0IsyS9Bx7RJULMGpzL22S4o/4/tfj345uJM63Qmc/o=";
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

      mkProjectApplications =
        system:
        let
          pkgs = mkPkgs system;
          nodejs = pkgs.nodejs_24;
          pnpm = mkPnpm pkgs nodejs;

          projectRuntime = pkgs.writeShellApplication {
            name = "t3code-project-runtime";
            runtimeInputs = [
              nodejs
              pkgs.bash
              pkgs.coreutils
              pkgs.findutils
              pkgs.gcc
              pkgs.git
              pkgs.gnumake
              pkgs.gnugrep
              pkgs.gnused
              pkgs.jq
              pkgs.pkg-config
              pkgs.python3
              pnpm
            ];
            text = ''
              set -euo pipefail

              action="''${1:-}"
              if [[ "$#" != 1 ]] || [[ "$action" != "prepare" && "$action" != "metro" ]]; then
                echo "usage: t3code-project-runtime <prepare|metro>" >&2
                exit 64
              fi

              runtime_file="''${PROJECT_RUNTIME_FILE:-}"
              if [[ -z "$runtime_file" ]]; then
                runtime_root="''${XDG_RUNTIME_DIR:-''${TMPDIR:-/tmp}/t3code-$UID}/project"
                state_root="''${XDG_STATE_HOME:-$HOME/.local/state}/t3code"
                cache_root="''${XDG_CACHE_HOME:-$HOME/.cache}/t3code"
                runtime_file="$runtime_root/runtime.json"
                install -d -m 0700 "$runtime_root" "$state_root" "$cache_root"
                jq -n \
                  --arg checkout "$PWD" \
                  --arg state "$state_root" \
                  --arg cache "$cache_root" \
                  --arg runtime "$runtime_root" \
                  '{
                    schemaVersion: 1,
                    project: "t3code",
                    realization: "development",
                    paths: {
                      checkout: $checkout,
                      state: $state,
                      cache: $cache,
                      runtime: $runtime
                    },
                    endpoints: {
                      metro: {
                        url: "http://127.0.0.1:8081",
                        visibility: "local",
                        listen: {host: "127.0.0.1", port: 8081}
                      }
                    },
                    settings: {},
                    secrets: {}
                  }' > "$runtime_file.next"
                mv "$runtime_file.next" "$runtime_file"
              fi

              if ! jq -e '
                .schemaVersion == 1 and
                .project == "t3code" and
                .realization == "development" and
                (.paths.checkout | type == "string" and length > 0) and
                (.paths.state | type == "string" and length > 0) and
                (.paths.cache | type == "string" and length > 0) and
                (.paths.runtime | type == "string" and length > 0) and
                (.endpoints | type == "object") and
                (.settings | type == "object") and
                (.secrets | type == "object")
              ' "$runtime_file" >/dev/null; then
                echo "T3 Code Project Runtime manifest is invalid: $runtime_file" >&2
                exit 65
              fi

              export PROJECT_RUNTIME_FILE="$runtime_file"
              checkout=$(jq -er '.paths.checkout' "$runtime_file")
              state_root=$(jq -er '.paths.state' "$runtime_file")
              cache_root=$(jq -er '.paths.cache' "$runtime_file")
              runtime_root=$(jq -er '.paths.runtime' "$runtime_file")
              install -d -m 0700 "$state_root" "$cache_root" "$runtime_root"

              case "$action" in
                prepare)
                  preparation_state="$state_root/preparation"
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
                  ;;

                metro)
                  if ! jq -e '
                    .endpoints.metro |
                    (.url | type == "string" and length > 0) and
                    (.listen.host == "127.0.0.1") and
                    (.listen.port | type == "number" and . >= 1 and . <= 65535)
                  ' "$runtime_file" >/dev/null; then
                    echo "T3 Code Project Endpoint is missing or invalid: metro" >&2
                    exit 65
                  fi

                  metro_url=$(jq -er '.endpoints.metro.url' "$runtime_file")
                  metro_port=$(jq -er '.endpoints.metro.listen.port' "$runtime_file")
                  metro_cache="$cache_root/metro"
                  install -d -m 0700 "$metro_cache/tmp"

                  export APP_VARIANT=development
                  export EXPO_PACKAGER_PROXY_URL="$metro_url"
                  export EXPO_UNSTABLE_HEADLESS=1
                  export NODE_OPTIONS="--dns-result-order=ipv4first''${NODE_OPTIONS:+ $NODE_OPTIONS}"
                  export TMPDIR="$metro_cache/tmp"
                  export XDG_CACHE_HOME="$metro_cache"

                  deep_link="t3code-dev://expo-development-client/?url=$(jq -rn --arg url "$metro_url" '$url | @uri')"
                  echo "T3 Code Dev Client: $deep_link"

                  cd "$checkout/apps/mobile"
                  exec pnpm exec expo start \
                    --dev-client \
                    --scheme t3code-dev \
                    --localhost \
                    --port "$metro_port"
                  ;;
              esac
            '';
          };

          preparation = pkgs.writeShellApplication {
            name = "t3code-prepare";
            text = ''
              exec ${projectRuntime}/bin/t3code-project-runtime prepare
            '';
          };

          development = pkgs.writeShellApplication {
            name = "t3code-development";
            text = ''
              set -euo pipefail

              if [[ "$#" == 2 && "$1" == "--only" && "$2" == "metro" ]]; then
                shift 2
              elif [[ "$#" != 0 ]]; then
                echo "usage: nix run .#dev [-- --only metro]" >&2
                exit 64
              fi

              exec ${projectRuntime}/bin/t3code-project-runtime metro
            '';
          };

          developmentMetro = pkgs.writeShellApplication {
            name = "t3code-development-metro";
            text = ''
              if [[ "$#" != 0 ]]; then
                echo "usage: nix run .#dev-metro" >&2
                exit 64
              fi
              exec ${development}/bin/t3code-development --only metro
            '';
          };
        in
        {
          inherit
            development
            developmentMetro
            preparation
            projectRuntime
            ;
        };

      projectApplications = forAllSystems mkProjectApplications;
    in
    {
      lib = {
        inherit mkT3CodePackage;
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
          projectRuntime = projectApplications.${system}.projectRuntime;
        }
      );

      apps = forAllSystems (
        system:
        let
          project = projectApplications.${system};
        in
        {
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/t3";
            meta.description = "Run the T3 Code server CLI";
          };
          t3 = self.apps.${system}.default;
          prepare = {
            type = "app";
            program = "${project.preparation}/bin/t3code-prepare";
          };
          dev = {
            type = "app";
            program = "${project.development}/bin/t3code-development";
          };
          dev-metro = {
            type = "app";
            program = "${project.developmentMetro}/bin/t3code-development-metro";
          };
        }
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
          runtime = projectApplications.${system}.projectRuntime;
        in
        {
          package = self.packages.${system}.default;
          projectDescriptor =
            pkgs.runCommand "t3code-project-descriptor-check"
              {
                nativeBuildInputs = [ pkgs.jq ];
                descriptor = pkgs.writeText "t3code-project.json" (builtins.toJSON projectDescriptor);
              }
              ''
                set -euo pipefail

                jq -e '
                  .schemaVersion == 1 and
                  .project == "t3code" and
                  (.development.endpoints | keys) == ["metro"] and
                  .development.endpoints.metro.health.paths == ["/status"]
                ' "$descriptor" >/dev/null

                touch "$out"
              '';
          projectRuntime = pkgs.runCommand "t3code-project-runtime-check" { } ''
            ${pkgs.bash}/bin/bash -n ${runtime}/bin/t3code-project-runtime
            grep -Fq '${pkgs.python3}/bin' ${runtime}/bin/t3code-project-runtime
            grep -Fq '${pkgs.gcc}/bin' ${runtime}/bin/t3code-project-runtime
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
