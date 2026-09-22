# Match the SPDX revision and cache version in scripts/lib/third-party-licenses.ts.
# Fixed-output fetches keep license generation offline inside the build sandbox.
{ pkgs }:
let
  revision = "c4a7237ec8f4654e867546f9f409749300f1bf4c";
  hashes = {
    "Apache-2.0" = "sha256-iyt7wmfXAL6UCFzSyDA+Atj4ODKLKnMQ3DqIQNPKErs=";
    "BSD-2-Clause" = "sha256-h2hDpwacR4mNECQyo1vjMqRXz3r/gJTMsYqj315jQJI=";
    "BSD-3-Clause" = "sha256-RXYFS3RBfUAh/9ovY7h/3lJ5Hj7ZTu7yznkwJRtDcwE=";
    "CC0-1.0" = "sha256-gdRg6RFSHhS1Ky/Y4Gl5Wscx6JhspYpdKUFdzAHqoSU=";
    "ISC" = "sha256-VJTDV7IdtsBt1r1r1J1ldZINPVNDQE5vVFkWPmjn5Yo=";
    "MIT" = "sha256-fuCJ3MxiW/GLCrHoDgxLysVYeIT1viXZATuK1sYd1Dk=";
    "Unlicense" = "sha256-itR5uQEH/xGJKbe09Fvk/axB/Aq0J6LEIbwwY52X4fs=";
  };
in
pkgs.runCommand "t3code-spdx-license-notices" { } (
  ''
    mkdir -p "$out/v3.28.0"
  ''
  + pkgs.lib.concatStringsSep "\n" (
    pkgs.lib.mapAttrsToList (
      license: hash:
      let
        source = pkgs.fetchurl {
          url = "https://raw.githubusercontent.com/spdx/license-list-data/${revision}/json/details/${license}.json";
          inherit hash;
        };
      in
      ''cp ${source} "$out/v3.28.0/${license}.json"''
    ) hashes
  )
)
