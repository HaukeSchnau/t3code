# The Linux workspace launcher behind isolated workspaces. The Release ships it
# and points T3CODE_EXECUTION_LAUNCHER at it (see flake.nix).
{
  pkgs,
  devenv,
  lib ? pkgs.lib,
}:
# The workspace adapter relies on 2.3.1's entry tasks and lock handling.
assert lib.assertMsg (devenv.version == "2.3.1") "agent-exec needs devenv 2.3.1";
let
  python = pkgs.python3.withPackages (p: [ p.tomli-w ]);
  # TODO: Remove this patch when unionfs stops logging every directory entry by default.
  workspaceUnionfs = pkgs.unionfs-fuse.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./agent-exec-unionfs-quiet.patch ];
  });
  baseline = pkgs.buildEnv {
    name = "agent-environment-baseline";
    paths =
      with pkgs;
      [
        bashInteractive
        coreutils
        findutils
        gnugrep
        gnused
        gawk
        ripgrep
        fd
        jq
        git
        jujutsu
        nix
        cacert
        openssh
        curl
        file
        which
        util-linux
        gzip
        gnutar
        unzip
        python3
      ]
      ++ [ devenv ];
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "agent-exec";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../native/agent-exec;
    fileset = lib.fileset.fileFilter (file: file.hasExt "py") ../native/agent-exec;
  };
  nativeBuildInputs = [ pkgs.makeWrapper ];
  doCheck = true;
  nativeCheckInputs = [
    python
    pkgs.jujutsu
    pkgs.git
  ];
  checkPhase = "python3 -B -m unittest discover -p 'test_*.py'";
  installPhase = ''
    mkdir -p $out/lib $out/bin
    cp agent_exec.py capabilities.py workspaces.py project_files.py projects.py tool_environments.py devenv_environment.py $out/lib/
    makeWrapper ${python}/bin/python3 $out/bin/agent-exec \
      --add-flags $out/lib/agent_exec.py \
      --set AGENT_EXEC_LAUNCHER $out/bin/agent-exec \
      --set AGENT_EXEC_BASE_PROFILE ${baseline} \
      --set AGENT_EXEC_REAL_BASH ${pkgs.bashInteractive}/bin/bash \
      --set AGENT_EXEC_DEVENV ${devenv}/bin/devenv \
      --set AGENT_EXEC_BWRAP ${pkgs.bubblewrap}/bin/bwrap \
      --prefix PATH : /run/wrappers/bin:${
        lib.makeBinPath [
          pkgs.bubblewrap
          pkgs.systemd
          pkgs.coreutils
          pkgs.util-linux
          pkgs.slirp4netns
          pkgs.tini
          workspaceUnionfs
          pkgs.fuse3
        ]
      }
  '';
  meta = {
    mainProgram = "agent-exec";
    platforms = lib.platforms.linux;
  };
}
