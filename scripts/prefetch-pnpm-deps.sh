#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

nix build --no-link --impure --expr '
let
  pkgs = import <nixpkgs> { system = builtins.currentSystem; };
  src = builtins.path {
    path = ./.;
    name = "t3code-src";
    filter = path: type: builtins.baseNameOf path != ".git";
  };
  pnpm = pkgs.pnpm_10.override { nodejs = pkgs.nodejs_24; };
  pkgJson = builtins.fromJSON (builtins.readFile ./apps/server/package.json);
in pkgs.fetchPnpmDeps {
  inherit src pnpm;
  pname = "t3code";
  version = pkgJson.version;
  fetcherVersion = 3;
  hash = pkgs.lib.fakeHash;
}
' 2>&1 | awk '/got:    sha256-/ { print $2; exit }'
