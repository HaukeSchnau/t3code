# The fleet world daemon behind thread worlds (native/worldfs, schnau/t3code#191). The
# Linux Release ships it as bin/worldfs, and infra's worldfs user unit runs that copy.
{
  pkgs,
  lib ? pkgs.lib,
}:
let
  src = lib.fileset.toSource {
    root = ../native/worldfs;
    fileset = lib.fileset.unions [
      ../native/worldfs/go.mod
      ../native/worldfs/go.sum
      (lib.fileset.fileFilter (file: file.hasExt "go") ../native/worldfs)
    ];
  };
in
pkgs.buildGoModule {
  pname = "worldfs";
  version = "0.1.0";
  inherit src;
  # The source's store hash: the same daemon source gives the same revision on every host, and
  # the daemon moves to a Release whose worldfs reports another one (README.md, Upgrades).
  ldflags = [ "-X main.revision=${builtins.substring 11 12 "${src}"}" ];
  vendorHash = "sha256-6CTXIcY+1t73uPllRNp/fcXaEl4A80dxy472fig1V40=";
  env.CGO_ENABLED = "0";
  nativeBuildInputs = [ pkgs.makeWrapper ];
  nativeCheckInputs = [
    pkgs.git
    pkgs.jujutsu
  ];
  preCheck = "export HOME=$TMPDIR";
  # fusermount3 must be the setuid wrapper on NixOS; the store copy is a fallback elsewhere.
  postInstall = ''
    wrapProgram $out/bin/worldfs --prefix PATH : /run/wrappers/bin:${
      lib.makeBinPath [
        pkgs.git
        pkgs.jujutsu
        pkgs.util-linux
        pkgs.fuse3
      ]
    }
  '';
  meta = {
    mainProgram = "worldfs";
    platforms = lib.platforms.linux;
  };
}
