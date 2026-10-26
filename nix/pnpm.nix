# pnpm 12 is a Rust program. nixpkgs lags the release the root `packageManager` pins, and its
# source build cannot build newer releases, so this installs that release's published binary.
pkgs:
let
  version = "12.14.0";
  platforms = {
    aarch64-linux = {
      name = "linux-arm64";
      hash = "sha256-58okIk62JqAygo7FhMZ5A60vOJkRuEnQCe1woZ9w2NM=";
    };
    x86_64-linux = {
      name = "linux-x64";
      hash = "sha256-HemO0uliEROwiHsGMitGHvud9z2RP8HRUQObELcRekE=";
    };
    aarch64-darwin = {
      name = "darwin-arm64";
      hash = "sha256-BhNpIMnMytT2FbsIDgVNmsCG/t/DJJe9h6iSt6RYb28=";
    };
    x86_64-darwin = {
      name = "darwin-x64";
      hash = "sha256-T+WqbAujAT+K77HMI908VPcnKBS+SwJ1601qmNd2niY=";
    };
  };
  platform = platforms.${pkgs.stdenv.hostPlatform.system};
in
pkgs.stdenv.mkDerivation {
  pname = "pnpm";
  inherit version;
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@pnpm/exe.${platform.name}/-/exe.${platform.name}-${version}.tgz";
    inherit (platform) hash;
  };
  nativeBuildInputs = [
    pkgs.makeWrapper
  ]
  ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.autoPatchelfHook;
  buildInputs = pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.stdenv.cc.cc.lib;
  installPhase = ''
    runHook preInstall
    install -Dm755 pnpm "$out/bin/pnpm"
    ln -s pnpm "$out/bin/pn"
    makeWrapper "$out/bin/pnpm" "$out/bin/pnpx" --add-flags dlx
    runHook postInstall
  '';
  # nixpkgs' fetchPnpmDeps runs its store helpers with this Node.
  passthru.nodejs-slim = pkgs.nodejs-slim_26;
  meta.mainProgram = "pnpm";
}
