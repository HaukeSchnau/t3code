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

      mkPkgs =
        system:
        import nixpkgs {
          inherit system;
        };

      mkT3CodePackage =
        pkgs:
        let
          nodejs = pkgs.nodejs_24;
          pnpm = pkgs.pnpm_10.override { inherit nodejs; };
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
        pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "t3code";
          version = packageJson.version;

          src = self;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            inherit pnpm;
            fetcherVersion = 3;
            hash = "sha256-AgM6uDetRZ96jVPt/ux76HVAtiLKkKl5JQfj3rBh8Og=";
          };

          nativeBuildInputs = [
            nodejs
            pkgs.makeWrapper
            pkgs.pkg-config
            pkgs.python3
            pkgs.pnpmConfigHook
            pnpm
          ];

          buildInputs = [
            nodejs
          ];

          env = {
            NODE_EXTRA_CA_CERTS = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
            SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
            npm_config_nodedir = nodejs;
          };

          buildPhase = ''
            runHook preBuild

            pnpm --filter @t3tools/web build
            node apps/server/scripts/cli.ts build

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            export runtimeRoot="$(mktemp -d)"
            mkdir -p "$runtimeRoot/apps/server"

            cp package.json pnpm-lock.yaml "$runtimeRoot/"
            cp -R patches "$runtimeRoot/patches"
            cp apps/server/package.json "$runtimeRoot/apps/server/package.json"
            cp -R apps/server/dist "$runtimeRoot/apps/server/dist"

            awk '
              BEGIN {
                print "packages:"
                print "  - apps/server"
              }
              /^catalog:/ {
                keep = 1
              }
              keep {
                print
              }
            ' pnpm-workspace.yaml > "$runtimeRoot/pnpm-workspace.yaml"

            (
              cd "$runtimeRoot"
              pnpm --offline install --prod --frozen-lockfile --filter t3 --ignore-scripts
              npm_config_build_from_source=true pnpm --filter t3 rebuild node-pty
            )

            mkdir -p "$out/lib"
            cp -R "$runtimeRoot/apps/server" "$out/lib/t3code"
            cp -R "$runtimeRoot/node_modules" "$out/node_modules"
            rm -f "$out/node_modules/.pnpm/node_modules/t3"

            mkdir -p "$out/bin"
            makeWrapper "${nodejs}/bin/node" "$out/bin/t3" \
              --add-flags "$out/lib/t3code/dist/bin.mjs" \
              --suffix PATH : "${runtimePath}" \
              --set-default NODE_ENV production

            runHook postInstall
          '';

          meta = {
            description = "Minimal web GUI for using coding agents like Codex and Claude";
            homepage = "https://github.com/pingdotgg/t3code";
            license = lib.licenses.mit;
            mainProgram = "t3";
            platforms = lib.platforms.unix;
          };
        });
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
        in
        rec {
          t3code = mkT3CodePackage pkgs;
          default = t3code;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/t3";
          meta.description = "Run the T3 Code server CLI";
        };
        t3 = self.apps.${system}.default;
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
          nodejs = pkgs.nodejs_24;
          pnpm = pkgs.pnpm_10.override { inherit nodejs; };
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

      checks = forAllSystems (system: {
        package = self.packages.${system}.default;
      });

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
