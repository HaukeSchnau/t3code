{ pkgs, inputs, ... }:
let
  nodejs = pkgs.nodejs_24;
  pnpm = (import ./nix/pnpm.nix) pkgs nodejs;
in
{
  imports = [
    (inputs.projectSdk + "/modules/devenv/project.nix")
    ./project.nix
  ];
  packages = [
    nodejs
    pnpm
    pkgs.git
    pkgs.jujutsu
    pkgs.openssh
    pkgs.pkg-config
    pkgs.python3
    pkgs.stdenv.cc
    pkgs.gnumake
  ];
  env.npm_config_nodedir = "${nodejs}";
  project.enable = true;
  tasks."t3:dependencies" = {
    before = [ "devenv:enterShell" ];
    exec = ''
      export CI=true
      pnpm install --frozen-lockfile
    '';
    execIfModified = [
      "devenv.lock"
      "nix/pnpm.nix"
      "package.json"
      "pnpm-lock.yaml"
      "pnpm-workspace.yaml"
      "apps/*/package.json"
      "packages/*/package.json"
      "patches/*.patch"
      "node_modules/.modules.yaml"
    ];
  };
  processes.web = {
    after = [ "t3:dependencies" ];
    project = {
      environment = {
        WEB_URL = {
          endpoint = "web";
          field = "url";
        };
        WEB_HOST = {
          endpoint = "web";
          field = "listen.host";
        };
        WEB_PORT = {
          endpoint = "web";
          field = "listen.port";
        };
        WEB_HOST_NAMES = {
          endpoint = "web";
          field = "hostNames";
        };
        T3_DEV_HOME = {
          path = "state";
          append = "t3-home";
        };
        T3_WEB_CACHE = {
          path = "cache";
          append = "web";
        };
      };
      endpoints.web = {
        port = 5173;
        health = {
          paths = [ "/healthz" ];
          startupTimeoutSec = 300;
          requestTimeoutSec = 300;
        };
      };
    };
    exec = ''
      web_host="''${WEB_HOST:-127.0.0.1}"
      web_port="''${WEB_PORT:-5173}"
      web_url="''${WEB_URL:-http://127.0.0.1:$web_port}"
      host_names="''${WEB_HOST_NAMES:-[\"localhost\",\"127.0.0.1\"]}"
      t3_home="''${T3_DEV_HOME:-$DEVENV_STATE/t3-home}"
      web_cache="''${T3_WEB_CACHE:-$DEVENV_STATE/web-cache}"
      install -d -m 0700 "$t3_home" "$web_cache"
      export XDG_CACHE_HOME="$web_cache"
      export PATH="$DEVENV_ROOT/node_modules/.bin:$PATH"
      export T3CODE_BUNDLED_DEV=1
      export T3CODE_DEV_ALLOWED_HOSTS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).join(","))' "$host_names")"
      unset AGENT_SERVICE_PORT AGENT_SERVICE_URL T3CODE_HOST T3CODE_PORT
      exec node scripts/dev-runner.ts dev --no-browser --host 127.0.0.1 \
        --home-dir "$t3_home" --web-host "$web_host" --web-port "$web_port" --dev-url "$web_url"
    '';
  };
  processes.mobile = {
    after = [ "t3:dependencies" ];
    project = {
      environment = {
        MOBILE_URL = {
          endpoint = "mobile";
          field = "url";
        };
        MOBILE_PORT = {
          endpoint = "mobile";
          field = "listen.port";
        };
        T3_MOBILE_CACHE = {
          path = "cache";
          append = "mobile";
        };
      };
      endpoints.mobile = {
        port = 8081;
        health = {
          paths = [ "/status" ];
          startupTimeoutSec = 300;
        };
      };
    };
    exec = ''
      mobile_port="''${MOBILE_PORT:-8081}"
      mobile_url="''${MOBILE_URL:-http://127.0.0.1:$mobile_port}"
      mobile_cache="''${T3_MOBILE_CACHE:-$DEVENV_STATE/mobile-cache}"
      install -d -m 0700 "$mobile_cache/tmp"
      export APP_VARIANT=development EXPO_UNSTABLE_HEADLESS=1
      export EXPO_PACKAGER_PROXY_URL="$mobile_url"
      export NODE_OPTIONS="--dns-result-order=ipv4first''${NODE_OPTIONS:+ $NODE_OPTIONS}"
      export TMPDIR="$mobile_cache/tmp" XDG_CACHE_HOME="$mobile_cache"
      encoded_url="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$mobile_url")"
      echo "T3 Code Dev Client: t3code-dev://expo-development-client/?url=$encoded_url"
      cd "$DEVENV_ROOT/apps/mobile"
      exec ./node_modules/.bin/expo start --dev-client --scheme t3code-dev --lan --port "$mobile_port"
    '';
  };
}
