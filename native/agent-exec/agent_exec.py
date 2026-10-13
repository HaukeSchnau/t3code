#!/usr/bin/env python3
"""Project filesystem environments and their host-side service bridge."""

import argparse
import capabilities
import workspaces
import project_files
import projects
import fcntl
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import uuid

STATE = Path(
    os.environ.get("AGENT_EXEC_STATE", str(Path.home() / ".local/state/agent-exec"))
)
PUBLISH_ROOT = Path("/srv/agent-share/isolated")
PUBLISH_URL = "https://files.schnau.dev/isolated"
LAUNCHER = os.environ.get("AGENT_EXEC_LAUNCHER", str(Path(__file__).resolve()))


def write_text(path, text):
    path = Path(path)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, delete=False
    ) as temporary:
        temporary.write(text)
        name = temporary.name
    os.replace(name, path)


def write_symlink(path, target):
    path = Path(path)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}")
    temporary.symlink_to(target)
    os.replace(temporary, path)


def update_shell_startup(path):
    """Restore project tools after /etc/profile resets PATH in a login shell."""
    legacy = 'export PATH="/run/agent-exec-bin:$PATH"\n'
    if not path.exists() or path.read_text() == legacy:
        write_text(path, 'export PATH="/run/agent-exec-bin:${AGENT_EXEC_ENVIRONMENT_PATH:-$PATH}:$PATH"\n')

def identity(root):
    return hashlib.sha256(str(root).encode()).hexdigest()[:20]


def record_path(root):
    return STATE / "projects" / (identity(root) + ".json")


def lookup(cwd):
    path = Path(cwd).resolve()
    for candidate in (path, *path.parents):
        file = record_path(candidate)
        if file.exists():
            record = json.loads(file.read_text())
            if record["root"] != str(candidate) or record["version"] != 1:
                raise ValueError("Invalid project environment record")
            return record
    return None


def project_state(record):
    return STATE / "environments" / identity(record["root"])


def run(command, **kwargs):
    kwargs.setdefault("timeout", 180)
    return subprocess.run(command, check=True, text=True, **kwargs)


def stop_unit(unit):
    loaded = subprocess.run(
        ["systemctl", "--user", "show", "--property=LoadState", "--value", unit],
        capture_output=True, text=True, timeout=15,
    )
    if loaded.stdout.strip() != "not-found":
        run(["systemctl", "--user", "stop", unit])


def create(root, project_id=None):
    root = Path(root).expanduser().resolve()
    existing = lookup(root)
    if existing and existing["root"] == str(root):
        # The root owns the environment; T3 allocates a new ID when readding
        # a removed project. Keep its state and files while updating that link.
        if not root.exists():
            root.mkdir(parents=True)
            (root / "t3.json").write_text(
                json.dumps({"defaultThreadEnvMode": "local"}, indent=2) + "\n"
            )
        if project_id and existing.get("projectId") != project_id:
            existing = {**existing, "projectId": project_id}
            write_text(record_path(root), json.dumps(existing) + "\n")
        ensure_bridge(existing)
        return existing
    if root.exists() and any(root.iterdir()):
        raise ValueError("Separate environments must start in a new or empty directory")
    if lookup(root):
        raise ValueError("This directory already belongs to a separate environment")
    root.mkdir(parents=True, exist_ok=True)
    record = {
        "version": 1,
        "root": str(root),
        "home": str(Path.home()),
        "projectId": project_id,
    }
    state = project_state(record)
    state.mkdir(parents=True, exist_ok=True)
    record_path(root).parent.mkdir(parents=True, exist_ok=True)
    write_text(record_path(root), json.dumps(record) + "\n")
    # The registry is outside the checkout: editing project files cannot silently disable it.
    (root / "t3.json").write_text(
        json.dumps({"defaultThreadEnvMode": "local"}, indent=2) + "\n"
    )
    ensure_bridge(record)
    return record


def ensure_bridge(record):
    bridge = project_state(record) / "bridge"
    bridge.mkdir(parents=True, exist_ok=True)
    unit = "agent-exec-" + identity(record["root"])
    with (bridge / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        version = bridge / "launcher"
        active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", unit])
        if (
            active.returncode == 0
            and version.exists()
            and version.read_text() == LAUNCHER
        ):
            return
        if active.returncode == 0:
            run(["systemctl", "--user", "stop", unit])
        run(
            [
                "systemd-run",
                "--user",
                "--quiet",
                "--collect",
                "--unit",
                unit,
                "--property=Type=notify",
                "--property=TimeoutStartSec=20",
                "--property=Restart=on-failure",
                "--property=RestartSec=2",
                "--setenv=PATH=" + os.environ["PATH"],
                "--setenv=AGENT_EXEC_STATE=" + str(STATE),
                *(
                    ["--setenv=T3CODE_HOME=" + os.environ["T3CODE_HOME"]]
                    if os.environ.get("T3CODE_HOME")
                    else []
                ),
                LAUNCHER,
                "bridge",
                "--root",
                record["root"],
            ]
        )
        version.write_text(LAUNCHER)


def bind(args, source, target=None, writable=False):
    source = Path(source)
    if source.exists():
        args.extend(
            [
                "--bind" if writable else "--ro-bind",
                str(source.resolve()),
                str(target or source),
            ]
        )


def bind_ssh_configs(args, state, host_home):
    """Keep OpenSSH's strict ownership checks valid for Nix-owned includes."""
    directory = state / "ssh-configs"
    directory.mkdir(exist_ok=True)
    pending = [
        (host_home / ".ssh/config", host_home / ".ssh"),
        (Path("/etc/ssh/ssh_config"), Path("/etc/ssh")),
    ]
    seen = set()
    while pending:
        source, base = pending.pop()
        source = source.resolve()
        if source in seen or not source.is_file():
            continue
        seen.add(source)
        # ~/.ssh is read-only inside the environment, so a multiplexing socket
        # there cannot bind. Disable it instead of failing every SSH connection.
        content = re.sub(r'^(\s*ControlPath(?:\s+|=)\s*)"?~/\.ssh/[^\s"]+"?[ \t]*$', r"\1none",
                         source.read_text(), flags=re.IGNORECASE | re.MULTILINE)
        owned = directory / identity(source)
        write_text(owned, content)
        bind(args, owned, source)
        for line in content.splitlines():
            include = re.match(r"^\s*Include(?:\s+|=)(.*)$", line, re.IGNORECASE)
            if include:
                for pattern in shlex.split(include[1], comments=True):
                    path = Path(pattern).expanduser()
                    if not path.is_absolute():
                        path = base / path
                    pending.extend(
                        (Path(match), base) for match in glob.glob(str(path))
                    )


def shares_files():
    """Only hosts with the Tailnet file share serve what an environment publishes."""
    return PUBLISH_ROOT.parent.is_dir()


def publish_directory(record):
    if not shares_files():
        # The environment keeps its /srv/agent-share mount; nothing serves it.
        directory = project_state(record) / "unshared"
        directory.mkdir(parents=True, exist_ok=True)
        return directory
    directory = PUBLISH_ROOT / identity(record["root"])
    directory.mkdir(parents=True, exist_ok=True)
    if directory.is_symlink() or PUBLISH_ROOT.is_symlink():
        raise ValueError("Separate publishing directories must not be symlinks")
    return directory


def launch(record, cwd, command, *, project=None):
    project_files.ensure(sys.modules[__name__], record)
    project_files.isolate_devenv_cwd(sys.modules[__name__], record, cwd)
    state = project_state(record)
    host_home = Path(record["home"])
    private_home = state / "home"
    private_home.mkdir(parents=True, exist_ok=True)
    ensure_bridge(record)
    workspace = record.get("workspace")
    project_environment = projects.activation(sys.modules[__name__], record, cwd)
    visible_root = workspaces.visible_root(record)
    minimal = workspace and workspace["profile"] == "minimal"
    network = (
        workspaces.ensure_network(sys.modules[__name__], record) if workspace else []
    )
    runtime_directory = "/tmp/runtime"
    namespace_fds = []
    if workspace:
        namespace = workspaces.ensure_process_namespace(sys.modules[__name__], record)
        runtime_directory = namespace["runtime"]
        namespace_fds = [os.open(f"/proc/{namespace['pid']}/ns/{name}", os.O_RDONLY)
                         for name in ["user", "pid_for_children"]]
    args = [
        "bwrap",
        *(["--clearenv"] if workspace else []),
        *(["--userns", str(namespace_fds[0]), "--pidns", str(namespace_fds[1])]
          if workspace else ["--unshare-pid"]),
        "--unshare-uts",
        "--unshare-ipc",
        "--die-with-parent",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/tmp/runtime",
    ]
    if workspace:
        for key, value in os.environ.items():
            if key in {
                "TERM",
                "LANG",
                "LC_ALL",
                "USER",
                "LOGNAME",
                "SSH_AUTH_SOCK",
                "SSL_CERT_FILE",
                "NIX_SSL_CERT_FILE",
                "PORT",
                "HOST",
                "AGENT_SERVICE_URL",
                "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
                "AGENT_EXEC_REAL_BASH",
                "AGENT_EXEC_ENVIRONMENT",
                "AGENT_EXEC_SETUP_TIMEOUT",
            } or key.startswith(("T3CODE_", "T3_", "CODEX_", "OPENAI_", "ANTHROPIC_")):
                args += ["--setenv", key, value]
            elif project and (key.startswith("PROJECT_") or key == "NOTIFY_SOCKET"):
                args += ["--setenv", key, value]
    # Nix store content and the OS are shared. User repositories and host process state are not.
    for path in [
        "/nix",
        "/etc",
        "/run/current-system",
        "/run/wrappers",
        "/bin",
        "/usr/bin",
        "/lib",
        "/lib64",
    ]:
        if workspace and path != "/nix":
            continue
        bind(args, path)
    if workspace:
        for path in [
            "/etc/ssl",
            "/etc/static/ssl",
            "/etc/nix",
            "/etc/static/nix",
            "/etc/hosts",
            "/etc/localtime",
        ]:
            bind(args, path)
        write_text(
            state / "passwd",
            f"{host_home.name}:x:{os.getuid()}:{os.getgid()}::{host_home}:/bin/bash\n",
        )
        write_text(state / "group", f"users:x:{os.getgid()}:\n")
        bind(args, state / "passwd", "/etc/passwd")
        bind(args, state / "group", "/etc/group")
        bind(args, os.environ["AGENT_EXEC_REAL_BASH"], "/bin/sh")
        bind(args, os.environ["AGENT_EXEC_REAL_BASH"], "/bin/bash")
        bind(args, workspace["baseProfile"] + "/bin/env", "/usr/bin/env")
    bind(args, "/nix/var/nix/daemon-socket", writable=True)
    bind(args, private_home, host_home, writable=True)
    if workspace:
        tools = state / "tools"
        tools.mkdir(exist_ok=True)
        bind(args, tools, writable=True)
        bind(args, tools, host_home / ".local/state/agent-environment", writable=True)
        tool_project = record.get("projectId") or workspace["sourceRoot"]
        shared_tools = STATE / "tool-environments" / identity(tool_project)
        shared_tools.mkdir(parents=True, exist_ok=True)
        bind(args, shared_tools, writable=True)
        args += ["--setenv", "AGENT_EXEC_SHARED_TOOL_CACHE", str(shared_tools)]
        if workspace.get("stableRuntimePath"):
            args += ["--setenv", "AGENT_EXEC_SHARED_DEVENV_CACHE", str(shared_tools / "devenv-eval")]
        if workspace.get("sharedPackageStore"):
            # Share downloaded packages within one project, never node_modules.
            # Older workspaces retain their original store location.
            package_store = shared_tools / "pnpm-store"
            package_store.mkdir(exist_ok=True)
            for prefix in ["pnpm_config_", "npm_config_"]:
                args += ["--setenv", prefix + "store_dir", str(package_store)]
                # Avoid hardlinks: dependency edits must not mutate shared content.
                args += ["--setenv", prefix + "package_import_method", "clone-or-copy"]
    for name in ["tmp/runtime", "attachments"]:
        (state / name).mkdir(parents=True, exist_ok=True)
    bind(args, state / "tmp", "/tmp", writable=True)
    bind(args, state / "tmp", writable=True)
    if workspace and workspace.get("stableRuntimePath"):
        # Keep generation-specific sockets private without baking a random path
        # into devenv's shell derivation. Existing workspaces retain their paths.
        bind(args, state / "tmp" / runtime_directory.removeprefix("/tmp/"),
             "/tmp/runtime", writable=True)
        runtime_directory = "/tmp/runtime"
    bind(
        args,
        state / "attachments",
        host_home / ".local/state/agent-bitwarden/attachments",
        writable=True,
    )
    if workspace:
        bind(args, record["root"], visible_root, writable=True)
    else:
        bind(args, record["root"], writable=True)
    publishing = publish_directory(record)
    bind(args, publishing, "/srv/agent-share", writable=True)
    # Host browsers return paths under this alias; the same path is readable
    # inside without exposing the rest of the host publication directory.
    publication_alias = state / "published"
    if not publication_alias.exists():
        publication_alias.symlink_to(publishing, target_is_directory=True)
    bind(args, publishing, publication_alias, writable=True)
    bind(args, state / "bridge", "/run/agent-exec", writable=True)
    projects.mounts(sys.modules[__name__], record, args)
    if project:
        bind(args, project["checkout"], "/tmp/project-devenv", writable=True)
        bind(args, Path(project["paths"]["cache"]) / "devenv", "/tmp/project-devenv/.devenv", writable=True)
        bind(args, Path(project["paths"]["runtime"]) / "devenv", "/tmp/devenv-runtime", writable=True)
        notify = os.environ.get("NOTIFY_SOCKET")
        if notify and not notify.startswith("@"):
            bind(args, notify, writable=True)
        args += ["--setenv", "PROJECT_WORKSPACE_ENTERED", "1"]
    bind(args, host_home / ".cache/ms-playwright")
    profile = host_home / ".nix-profile"
    if not workspace:
        bind(args, profile)
        bind(args, host_home / ".local/state/nix/profiles")

    # Preserve global instructions and installed capabilities, but not session history or memories.
    for name in [
        ".agents/skills",
        ".codex/skills",
        ".codex/plugins",
        ".codex/AGENTS.md",
        ".claude/skills",
        ".claude/plugins",
        ".config/git",
        ".ssh",
        ".gitconfig",
    ]:
        if minimal and (
            "skills" in name
            or "plugins" in name
            or name.endswith("AGENTS.md")
        ):
            continue
        bind(
            args,
            host_home / name,
            writable=name.startswith(".config/"),
        )
    # jj stores writable per-repository trust/config metadata next to user
    # settings. Keep that state private, while sharing familiar user settings.
    if not minimal:
        jj_home = host_home / ".config/jj"
        (private_home / ".config/jj").mkdir(parents=True, exist_ok=True)
        if jj_home.is_dir():
            for entry in jj_home.iterdir():
                if entry.name not in {"repos", "workspaces"}:
                    bind(args, entry)
    provider_home = Path(os.environ.get("CODEX_HOME", str(host_home / ".codex")))
    private_codex = state / "codex" / identity(provider_home)
    private_codex.mkdir(parents=True, exist_ok=True)
    bind(args, private_codex, provider_home, writable=True)
    for name in ["config.toml", "skills", "plugins"]:
        if workspace and name == "config.toml":
            workspaces.provider_config(provider_home / name, private_codex / name)
            continue
        if minimal and name in ["skills", "plugins"]:
            continue
        bind(args, provider_home / name)
    instructions = provider_home / "AGENTS.md"
    original = instructions.read_text() if instructions.exists() and not minimal else ""
    if workspace and (state / "profile/codex.md").exists():
        original = (state / "profile/codex.md").read_text()
    write_text(
        private_codex / "AGENTS.md",
        original + "\n\n# Separate project environment\n"
        "You are in a separate filesystem environment for a fresh project. Other repositories are not mounted. "
        "Network and the tools selected for this environment are available. Use agent-service for project previews; "
        'it runs services in this same environment. For infrastructure or tooling problems, start a T3 thread in the infra project '
        "with the problem and evidence, then watch that thread so its answer wakes you. "
        "Account commands (gog, himalaya, bw-personal, bw-work, slackcli, gh, tea) run through the host bridge with native authentication and standard input/output. Use project paths or /tmp for file exchange. "
        "agent-browser is a fresh project browser. For existing account logins or passkeys, use agent-browser-personal or agent-browser-buildlinx explicitly; bitwarden-browser-ui-personal and bitwarden-browser-ui-work control their Bitwarden passkey popups. "
        "play-console-browser drives the persistent Google Play Console browser signed in to the Urbs developer account; use it for console-only steps such as creating apps. "
        "asc (App Store Connect) and gplay (Google Play Console) run through the bridge with the Urbs UG store credentials; the app-stores skill covers them. "
        "Project tools come from the nearest devenv.nix, or flake.nix when there is none; every command activates it automatically. To add project tools, write devenv.nix and commit the devenv.lock it creates; do not hard-code /nix/store paths. The first activation can take a few minutes.\n"
        "Do not work around missing host paths by searching unrelated projects. Published URLs require the Tailnet route; use agent-service verify NAME to check a preview from the host. Local curl checks use the internal port, not the published hostname.\n"
        + (
            f"Publish files under /srv/agent-share; this is only your project directory. Its Tailnet URL prefix is {PUBLISH_URL}/{identity(record['root'])}. Use that prefix, not the global files.schnau.dev root. After copying or moving files, run chmod -R g+rX on the published files/directories so the web server can read them.\n"
            if shares_files()
            else ""
        ),
    )
    claude_instructions = host_home / ".claude/CLAUDE.md"
    if workspace and (state / "profile/claude.md").exists():
        claude_instructions = state / "profile/claude.md"
    private_claude = private_home / ".claude"
    private_claude.mkdir(exist_ok=True)
    write_text(
        private_claude / "CLAUDE.md",
        (
            claude_instructions.read_text()
            if claude_instructions.exists() and not minimal
            else ""
        )
        + '\n\n# Separate project environment\nUse agent-service for project previews. For infrastructure or tooling problems, start a T3 thread in the infra project with the problem and evidence, then watch that thread so its answer wakes you. Other project directories are not mounted. Use agent-service verify NAME to check a published preview from the host; local curl checks use the internal port.\n'
        + "Project tools come from the nearest devenv.nix, or flake.nix when there is none; every command activates it automatically. To add project tools, write devenv.nix and commit the devenv.lock it creates; do not hard-code /nix/store paths. The first activation can take a few minutes.\n"
        + "Account tools use native host authentication through the bridge. Use project paths or /tmp for file exchange. agent-browser starts a project browser; agent-browser-personal and agent-browser-buildlinx explicitly use existing account contexts, with bitwarden-browser-ui-personal and bitwarden-browser-ui-work for their passkey popups. play-console-browser drives the persistent Google Play Console browser signed in to the Urbs developer account. asc (App Store Connect) and gplay (Google Play Console) use the Urbs UG store credentials; the app-stores skill covers them.\n"
        + (
            f"Publish /srv/agent-share files using URL prefix {PUBLISH_URL}/{identity(record['root'])}. This overrides the global sharing path-to-URL mapping. These URLs are Tailnet-only. After copying or moving files, run chmod -R g+rX on the published files/directories so the web server can read them.\n"
            if shares_files()
            else ""
        ),
    )
    # Codex 0.153.4 FileAuthStorage saves in place. Share the native auth inode,
    # not a copied refresh token. Account login/logout belongs to outside help.
    bind(args, provider_home / "auth.json", writable=True)
    # Claude may atomically replace credentials. Keep its config directory shared,
    # masking runtime entries with private storage so native refresh remains native.
    claude_home = host_home / ".claude"
    if claude_home.exists():
        bind(args, claude_home, writable=True)
        shared = {
            ".credentials.json",
            "settings.json",
            "settings.local.json",
            "skills",
            "plugins",
            "CLAUDE.md",
        }
        if minimal:
            shared -= {"skills", "plugins"}
        runtime_dirs = {
            "projects",
            "debug",
            "session-env",
            "tasks",
            "todos",
            "cache",
            "telemetry",
            "shell-snapshots",
            "plans",
        }
        names = (
            {entry.name for entry in claude_home.iterdir()}
            | runtime_dirs
            | {"history.jsonl"}
        )
        for name in sorted(names - shared):
            private = private_claude / name
            if not private.exists():
                if name in runtime_dirs or (claude_home / name).is_dir():
                    private.mkdir(parents=True, exist_ok=True)
                else:
                    private.touch(mode=0o600)
            destination = claude_home / name
            bind(
                args,
                private,
                destination.resolve() if destination.is_symlink() else destination,
                writable=True,
            )
        # Home Manager installs this as a Nix-store symlink. Mount over its
        # resolved destination inside the namespace, not over the host symlink.
        bind(args, private_claude / "CLAUDE.md", (claude_home / "CLAUDE.md").resolve())
    # Non-credential account preferences and settings can remain private.
    for source, destination in [
        (host_home / ".claude.json", private_home / ".claude.json"),
        (host_home / ".claude/settings.json", private_home / ".claude/settings.json"),
    ]:
        if source.exists() and (
            not destination.exists()
            or source.stat().st_mtime > destination.stat().st_mtime
        ):
            destination.parent.mkdir(parents=True, exist_ok=True)
            if workspace:
                settings = json.loads(source.read_text())
                settings.pop("projects", None)
                if minimal:
                    settings.pop("hooks", None)
                write_text(destination, json.dumps(settings) + "\n")
            else:
                shutil.copyfile(source, destination)
            destination.chmod(0o600)
    if minimal:
        jj_config = private_home / ".config/jj/config.toml"
        if not jj_config.exists():
            jj_config.parent.mkdir(parents=True, exist_ok=True)
            values = {
                key: run(
                    ["jj", "config", "get", "user." + key], capture_output=True
                ).stdout.strip()
                for key in ["name", "email"]
            }
            write_text(
                jj_config,
                "[user]\n"
                + "\n".join(
                    key + " = " + json.dumps(value) for key, value in values.items()
                )
                + "\n",
            )
    # T3 materializes selected skills outside the checkout. Expose only that generated catalog.
    t3_home = Path(os.environ.get("T3CODE_HOME", str(host_home / ".t3")))
    for name in ["userdata/skill-scopes", "userdata/attachments"]:
        bind(args, t3_home / name)

    bin_dir = state / "bin"
    bin_dir.mkdir(exist_ok=True)
    for name, method in [
        ("agent-service", "service"),
        *((name, "capability " + name) for name in capabilities.COMMANDS),
    ]:
        script = bin_dir / name
        script.write_text(
            "#!" + os.environ["AGENT_EXEC_REAL_BASH"] + "\nexec "
            + shlex.quote(LAUNCHER)
            + (" " if method.startswith("capability ") else " request ")
            + method
            + ' "$@"\n'
        )
        script.chmod(0o755)
    bind(args, bin_dir, "/run/agent-exec-bin")
    # T3's device_open advertises its host CLI path verbatim. Serve the
    # capability wrapper there; the host side validates --config itself.
    # A file in the private home reaches already-running sandboxes too, whose
    # mount namespace predates this launch; a bind only reaches new ones.
    device = t3_home / "userdata/device/bin/agent-device"
    if device.is_relative_to(host_home):
        target = private_home / device.relative_to(host_home)
        target.parent.mkdir(parents=True, exist_ok=True)
        write_text(target, (bin_dir / "agent-device").read_text())
        target.chmod(0o755)
    else:
        bind(args, bin_dir / "agent-device", device)
    if workspace:
        # Provider binaries remain available without inheriting the host's PATH.
        # Relink on every launch because garbage collection deletes older store paths.
        for name in ["codex", "claude", "jj-pull", "jj-push"]:
            binary = shutil.which(name)
            if binary:
                write_symlink(bin_dir / name, Path(binary).resolve())
        # Retained workspaces keep their old baseline profile; use the CLI
        # matching this launcher's adapter for explicit devenv commands too.
        devenv = bin_dir / "devenv"
        devenv.write_text(
            "#!" + os.environ["AGENT_EXEC_REAL_BASH"] + "\nexec "
            + shlex.quote(os.environ["AGENT_EXEC_DEVENV"]) + ' "$@"\n'
        )
        devenv.chmod(0o755)
        for name in ["bash", "sh"]:
            script = bin_dir / name
            script.write_text(
                "#!"
                + os.environ["AGENT_EXEC_REAL_BASH"]
                + "\nexec "
                + shlex.quote(LAUNCHER)
                + " activate -- "
                + name
                + ' "$@"\n'
            )
            script.chmod(0o755)
            bind(args, script, "/bin/" + name)
        # slirp supplies DNS independently of the host's loopback resolver.
        write_text(state / "resolv.conf", "nameserver 10.0.2.3\n")
        bind(args, state / "resolv.conf", "/etc/resolv.conf")
    for name in [".bash_profile", ".zprofile", ".zshrc"]:
        startup = private_home / name
        update_shell_startup(startup)
    # Local Git keeps normal settings and signing keys. Its pinned GitHub helper
    # must go through the account bridge instead of a credential-less host binary.
    config_count = int(os.environ.get("GIT_CONFIG_COUNT", "0"))
    for key, value in [
        ("credential.https://github.com.helper", ""),
        ("credential.https://github.com.helper", "!gh auth git-credential"),
        ("credential.https://gist.github.com.helper", ""),
        ("credential.https://gist.github.com.helper", "!gh auth git-credential"),
    ]:
        args += [
            "--setenv",
            f"GIT_CONFIG_KEY_{config_count}",
            key,
            "--setenv",
            f"GIT_CONFIG_VALUE_{config_count}",
            value,
        ]
        config_count += 1
    args += ["--setenv", "GIT_CONFIG_COUNT", str(config_count)]
    ssh_socket = os.environ.get("SSH_AUTH_SOCK")
    bind_ssh_configs(args, state, host_home)
    if ssh_socket and Path(ssh_socket).exists():
        bind(args, ssh_socket, writable=True)
    path = "/run/agent-exec-bin:" + os.environ["PATH"]
    if workspace:
        path = "/run/agent-exec-bin:" + workspace["baseProfile"] + "/bin"
        if project_environment:
            context_bin = str(Path(project["executable"]).parent) if project else project_environment["PROJECT_CONTEXT_BIN"]
            path = context_bin + ":" + path
            for key, value in project_environment.items():
                args += ["--setenv", key, value]
        if project:
            for key, value in {
                "PROJECT_RUNTIME_FILE": project["paths"]["runtime"] + "/runtime.json",
                "PROJECT_SECRETS_DIR": project["paths"]["runtime"] + "/workspace-secrets",
            }.items():
                args += ["--setenv", key, value]
        args += [
            "--setenv",
            "AGENT_EXEC_BASE_PATH",
            path,
            "--setenv",
            "AGENT_EXEC_TOOL_CACHE",
            str(state / "tools"),
            "--setenv",
            "AGENT_EXEC_REAL_BASH",
            os.environ["AGENT_EXEC_REAL_BASH"],
        ]
        relative = Path(cwd).resolve().relative_to(record["root"])
        cwd = str(Path(visible_root) / relative)
        command = list(command)
        if Path(command[0]).is_absolute() and Path(command[0]).exists():
            command[0] = str(Path(command[0]).resolve())
        command = [
            visible_root + arg[len(record["root"]) :]
            if arg == record["root"] or arg.startswith(record["root"] + "/")
            else arg
            for arg in command
        ]
        if not project:
            command = [LAUNCHER, "activate", "--", *command]
    args += [
        "--setenv",
        "AGENT_EXEC_WORKSPACE_LAYOUT",
        workspace.get("layout", "") if workspace else "",
        "--setenv",
        "HOME",
        str(host_home),
        "--setenv",
        "CODEX_HOME",
        str(provider_home),
        "--setenv",
        "PATH",
        path,
        *(
            ["--setenv", "AGENT_SHARE_URL", f"{PUBLISH_URL}/{identity(record['root'])}"]
            if shares_files()
            else []
        ),
        "--setenv",
        "AGENT_EXEC_ROOT",
        visible_root,
        "--setenv",
        "AGENT_EXEC_HOST_ROOT",
        record["root"],
        "--setenv",
        "TMPDIR",
        "/tmp" if workspace and workspace.get("stableRuntimePath") else str(state / "tmp"),
        "--setenv",
        "AGENT_EXEC_INSIDE",
        "1",
        "--setenv",
        "XDG_RUNTIME_DIR",
        runtime_directory,
        "--unsetenv",
        "DBUS_SESSION_BUS_ADDRESS",
        "--chdir",
        str(cwd) if workspace else str(Path(cwd).resolve()),
        "--",
        *command,
    ]
    args = [*network, *args]
    if project and os.environ.get("PROJECT_EXECUTION_ACTION") == "manager":
        # Project's service already belongs to the workspace slice. Its native
        # readiness notification must come from that service's own cgroup.
        return workspaces.run_scope(args, None, namespace_fds)
    if workspace:
        scope = "agent-command-" + uuid.uuid4().hex + ".scope"
        args = [
            "systemd-run",
            "--user",
            "--scope",
            "--quiet",
            "--expand-environment=no",
            "--unit=" + scope,
            "--property=TimeoutStopSec=10",
            "--slice=agent-env-" + identity(record["root"]) + ".slice",
            *(
                ["--property=BindsTo=" + os.environ["AGENT_SERVICE_UNIT"],
                 "--property=After=" + os.environ["AGENT_SERVICE_UNIT"]]
                if os.environ.get("AGENT_SERVICE_UNIT") else []
            ),
            *args,
        ]
        return workspaces.run_scope(args, scope, namespace_fds)
    os.execvp(args[0], args)


def service_command(record, argv):
    if len(argv) < 2:
        raise ValueError(
            "Use agent-service <run|stop|status|logs|inspect|verify|publish|unpublish|url|wait> <name>"
        )
    operation, name, *rest = argv
    if operation not in {
        "run",
        "stop",
        "restart",
        "status",
        "logs",
        "inspect",
        "verify",
        "publish",
        "unpublish",
        "url",
        "wait",
        "latest-url",
    }:
        raise ValueError(
            "This operation needs outside help; start a T3 thread in the infra project and watch it"
        )
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,48}", name):
        raise ValueError("Use a short project-local service name")
    name = "px-" + identity(record["root"])[:10] + "-" + name
    if "--follow" in rest:
        raise ValueError("Use finite log reads through the project bridge")
    if operation == "run":
        split = rest.index("--")
        options, command = rest[:split], rest[split + 1 :]
        if not command:
            raise ValueError("Missing service command")
        cwd = record["root"]
        if "--cwd" in options:
            index = options.index("--cwd")
            cwd = (
                str(
                    workspaces.host_path(
                        sys.modules[__name__], record, options[index + 1]
                    ).resolve()
                )
                if record.get("workspace")
                else str(Path(options[index + 1]).resolve())
            )
            if not Path(cwd).is_relative_to(record["root"]):
                raise ValueError("Service cwd must be inside this project")
            options[index + 1] = cwd
        else:
            options += ["--cwd", cwd]
        rest = [*options, "--", LAUNCHER, "exec", "--cwd", cwd, "--", *command]
        if record.get("workspace"):
            if "--port" not in options:
                options += ["--port", "auto"]
            port_index = options.index("--port") + 1
            guest_port = (
                3000 if options[port_index] == "auto" else int(options[port_index])
            )
            if not 1 <= guest_port <= 65535:
                raise ValueError("Invalid service port")
            options[port_index] = "auto"
            rest = [
                *options,
                "--",
                LAUNCHER,
                "workspace-service",
                "--cwd",
                cwd,
                "--port",
                str(guest_port),
                "--",
                *command,
            ]
    return ["agent-service", operation, name, *rest]


def service_metadata(record, name):
    file = Path(record["home"]) / ".local/state/agent-service/services" / (name + ".json")
    return json.loads(file.read_text()) if file.exists() else {}


def service_guest_port(metadata):
    command = metadata.get("command", [])
    if len(command) > 1 and command[1] == "workspace-service":
        return int(command[command.index("--port") + 1])
    return metadata.get("port")


def service_output(record, argv, metadata, output):
    """Present the service using the caller's filesystem and network namespace."""
    if not record.get("workspace") or argv[0] in {"logs", "url", "latest-url"}:
        return output
    output = output.replace(record["root"], workspaces.visible_root(record))
    host_port, guest_port = metadata.get("port"), service_guest_port(metadata)
    if host_port is not None and guest_port is not None:
        output = output.replace(f"127.0.0.1:{host_port}", f"127.0.0.1:{guest_port}")
        output = re.sub(rf"(port(?: listening)?:?\s+){host_port}\b", rf"\g<1>{guest_port}", output)
    if argv[0] in {"run", "inspect", "verify"}:
        output += "Use the port above inside this workspace. Published URLs are Tailnet-only; agent-service verify checks them from the host.\n"
    return output


def host_request(record, request):
    method, argv = request["method"], request["args"]
    if not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("Arguments must be strings")
    if method == "environment-root":
        if len(argv) != 1:
            raise ValueError("Expected one workspace environment root")
        relative = Path(argv[0]).relative_to(workspaces.visible_root(record))
        directory = (Path(record["root"]) / relative).resolve()
        if not directory.is_relative_to(Path(record["root"])):
            raise ValueError("Environment root must stay inside the workspace")
        project_files.isolate_devenv_cwd(sys.modules[__name__], record, directory)
        return {"code": 0, "stdout": "", "stderr": ""}
    env = dict(os.environ)
    if method == "service" and argv in ([], ["--help"], ["-h"], ["help"]):
        return {
            "code": 0,
            "stdout": (
                "Project-local services\n\n"
                "  agent-service list\n"
                "  agent-service run NAME --port PORT --publish --ttl 4h -- COMMAND...\n"
                "  agent-service <status|logs|inspect|verify|url|latest-url|wait> NAME\n"
                "  agent-service <stop|restart|publish|unpublish> NAME\n\n"
                "Names are scoped to this project. run also accepts --cwd DIR and --wait-http PATH.\n"
                "In independent workspaces, PORT is the internal port; listen on 0.0.0.0.\n"
                "Published URLs are Tailnet-only. Use verify NAME for a host-side service check.\n"
                "Use finite log reads; --follow is unavailable through this bridge.\n"
            ),
            "stderr": "",
        }
    if method == "service" and argv == ["list"]:
        prefix = "px-" + identity(record["root"])[:10] + "-"
        directory = Path(record["home"]) / ".local/state/agent-service/services"
        services = []
        for file in sorted(directory.glob(prefix + "*.json")):
            metadata = json.loads(file.read_text())
            services.append(
                {
                    "name": file.stem.removeprefix(prefix),
                    **{
                        key: metadata.get(key)
                        for key in ["published", "hostName"]
                    },
                    "port": service_guest_port(metadata),
                }
            )
        return {
            "code": 0,
            "stdout": json.dumps({"services": services}) + "\n",
            "stderr": "",
        }
    if method != "service":
        raise ValueError("Unknown bridge method")
    command = service_command(record, argv)
    result = subprocess.run(
        command,
        cwd=record["root"],
        env=env,
        text=True,
        capture_output=True,
        timeout=180,
    )
    output = result.stdout
    for operation in ["logs", "publish", "inspect", "verify", "stop"]:
        output = output.replace(f"agent-service {operation} {command[2]}", f"agent-service {operation} {argv[1]}")
    output = service_output(record, argv, service_metadata(record, command[2]), output)
    return {"code": result.returncode, "stdout": output, "stderr": result.stderr}


def bridge(record):
    state = project_state(record)
    capability_server = capabilities.start_server(
        sys.modules[__name__],
        state / "bridge/capabilities",
        record,
        state,
        publish_directory(record),
    )

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            try:
                request = json.loads(self.rfile.readline(1024 * 1024))
                response = host_request(record, request)
            except Exception as error:
                response = {"code": 1, "stdout": "", "stderr": str(error) + "\n"}
            self.wfile.write(json.dumps(response).encode() + b"\n")

    path = project_state(record) / "bridge" / "socket"
    path.unlink(missing_ok=True)
    with socketserver.ThreadingUnixStreamServer(str(path), Handler) as server:
        path.chmod(0o600)
        if os.environ.get("NOTIFY_SOCKET"):
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
                address = os.environ["NOTIFY_SOCKET"]
                notify.connect(
                    "\0" + address[1:] if address.startswith("@") else address
                )
                notify.sendall(b"READY=1")
        try:
            server.serve_forever()
        finally:
            capability_server.shutdown()
            capability_server.server_close()


def request(method, argv):
    with socket.socket(socket.AF_UNIX) as client:
        client.connect("/run/agent-exec/socket")
        client.sendall(
            json.dumps(
                {
                    "method": method,
                    "args": argv,
                }
            ).encode()
            + b"\n"
        )
        response = json.loads(client.makefile().readline())
    sys.stdout.write(response["stdout"])
    sys.stderr.write(response["stderr"])
    return response["code"]


def main():
    os.umask(0o077)
    if len(sys.argv) > 2 and sys.argv[1] == "activate":
        command = sys.argv[2:]
        return workspaces.activate(command[1:] if command[:1] == ["--"] else command)
    if len(sys.argv) > 2 and sys.argv[1] == "capability":
        return capabilities.call(sys.argv[2], sys.argv[3:])
    if len(sys.argv) > 2 and sys.argv[1] == "request":
        return request(sys.argv[2], sys.argv[3:])
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    new = sub.add_parser("create", help="Create an empty separate project environment")
    new.add_argument("root")
    new.add_argument("--project-id")
    fork = sub.add_parser(
        "fork", help="Create an independent jj environment at a selected revision"
    )
    fork.add_argument("source")
    fork.add_argument("destination")
    fork.add_argument("--name", required=True)
    fork.add_argument("--revision", required=True)
    fork.add_argument("--profile", choices=["minimal", "familiar"], default="minimal")
    fork.add_argument("--workspace-id", help="T3 workspace identity; enables safe creation retries")
    fork.add_argument("--project-id", help="Owning T3 project")
    collect = sub.add_parser(
        "collect",
        help="Import a selected jj change without editing the destination working copy",
    )
    collect.add_argument("source")
    collect.add_argument("destination")
    collect.add_argument("--revision", required=True)
    network = sub.add_parser("network")
    network.add_argument("--root", required=True)
    environment = sub.add_parser("environment", help="Inspect the workspace execution environment without starting it")
    environment.add_argument("--cwd", required=True)
    project_bind = sub.add_parser("bind-project")
    project_bind.add_argument("--cwd", required=True)
    project_bind.add_argument("--file", required=True)
    project_unbind = sub.add_parser("unbind-project")
    project_unbind.add_argument("--cwd", required=True)
    project_unbind.add_argument("--instance", required=True)
    project_run = sub.add_parser("project-run")
    project_run.add_argument("--cwd", required=True)
    project_run.add_argument("--file", required=True)
    project_run.add_argument("command", nargs=argparse.REMAINDER)
    process_namespace = sub.add_parser("process-namespace")
    process_namespace.add_argument("--root", required=True)
    filesystem = sub.add_parser("filesystem", help="Supervise a registered directory workspace mount")
    filesystem.add_argument("--id", required=True)
    service = sub.add_parser("workspace-service")
    service.add_argument("--cwd", required=True)
    service.add_argument("--port", required=True, type=int)
    service.add_argument("command", nargs=argparse.REMAINDER)
    resolve = sub.add_parser(
        "resolve-path", help="Resolve a namespace file for the host UI"
    )
    resolve.add_argument("--root", required=True)
    resolve.add_argument("path")
    stop = sub.add_parser(
        "retire",
        help="Stop an environment while retaining all repository and private files",
    )
    stop.add_argument("root")
    stop.add_argument("--remove-checkout", action="store_true",
                      help="Also remove the checkout and private state; used after T3's workspace deletion checks")
    for name in ["auto", "exec"]:
        command = sub.add_parser(name)
        command.add_argument("--cwd", required=True)
        command.add_argument("--environment", choices=["auto", "devenv", "flake", "baseline"],
                             help="Select a tool backend; baseline skips project setup for repairs")
        command.add_argument("--setup-timeout", type=int,
                             help="Seconds allowed per devenv setup step or lock wait (default: 900)")
        command.add_argument("command", nargs=argparse.REMAINDER)
    server = sub.add_parser("bridge")
    server.add_argument("--root", required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("root")
    args = parser.parse_args()
    runtime = sys.modules[__name__]
    if args.operation == "fork":
        print(
            json.dumps(
                workspaces.fork(
                    runtime,
                    args.source,
                    args.destination,
                    args.name,
                    args.revision,
                    args.profile,
                    workspace_id=args.workspace_id,
                    project_id=args.project_id,
                )
            )
        )
    elif args.operation == "collect":
        print(
            json.dumps(workspaces.collect(args.source, args.destination, args.revision))
        )
    elif args.operation == "filesystem":
        if not re.fullmatch(r"[0-9a-f]{20}", args.id):
            raise ValueError("Invalid workspace filesystem id")
        record = json.loads((STATE / "projects" / (args.id + ".json")).read_text())
        if identity(record["root"]) != args.id:
            raise ValueError("Invalid workspace filesystem registration")
        project_files.serve(runtime, record)
    elif args.operation == "environment":
        print(json.dumps(projects.environment(runtime, args.cwd)))
    elif args.operation in ["bind-project", "unbind-project", "project-run"]:
        record = lookup(args.cwd)
        if not record or not record.get("workspace"):
            raise ValueError("Project execution requires a registered workspace")
        if args.operation == "bind-project":
            projects.bind(runtime, record, args.file)
        elif args.operation == "unbind-project":
            projects.unbind(runtime, record, args.instance)
        else:
            command = args.command[1:] if args.command[:1] == ["--"] else args.command
            return projects.run(runtime, record, args.file, command)
    elif args.operation in ["network", "process-namespace", "resolve-path", "retire", "workspace-service"]:
        record = lookup(
            args.cwd if args.operation == "workspace-service" else args.root
        )
        if not record:
            raise ValueError("No separate environment registered here")
        if args.operation == "network":
            workspaces.network(runtime, record)
        elif args.operation == "process-namespace":
            workspaces.process_namespace(runtime, record)
        elif args.operation == "workspace-service":
            command = args.command[1:] if args.command[:1] == ["--"] else args.command
            return workspaces.service(runtime, record, args.cwd, args.port, command)
        elif args.operation == "resolve-path":
            print(workspaces.host_path(runtime, record, args.path))
        else:
            if args.remove_checkout and Path(args.root).resolve() != Path(record["root"]):
                raise ValueError("Remove the workspace root, not a directory inside it")
            projects.retire(runtime, record)
            prefix = "px-" + identity(record["root"])[:10] + "-"
            directory = Path(record["home"]) / ".local/state/agent-service/services"
            for file in directory.glob(prefix + "*.json"):
                run(["agent-service", "unpublish", file.stem])
                stop_unit("agent-service-" + file.stem + ".service")
            stop_unit("agent-exec-" + identity(record["root"]))
            if record.get("workspace"):
                stop_unit("agent-env-" + identity(record["root"]) + ".slice")
            if args.remove_checkout:
                project_files.remove_checkout(runtime, record)
            print(json.dumps({"root": record["root"], "retained": not args.remove_checkout}))
    elif args.operation == "create":
        print(json.dumps(create(args.root, args.project_id)))
    elif args.operation in ["inspect", "bridge"]:
        record = lookup(args.root)
        if not record:
            raise ValueError("No separate environment registered here")
        if args.operation == "inspect":
            print(json.dumps(record))
        else:
            bridge(record)
    else:
        if args.environment:
            os.environ["AGENT_EXEC_ENVIRONMENT"] = args.environment
        if args.setup_timeout is not None:
            if args.setup_timeout <= 0:
                parser.error("--setup-timeout must be a positive number of seconds")
            os.environ["AGENT_EXEC_SETUP_TIMEOUT"] = str(args.setup_timeout)
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            raise ValueError("Missing command")
        record = lookup(args.cwd)
        if record and not os.environ.get("AGENT_EXEC_INSIDE"):
            return launch(record, args.cwd, command)
        elif args.operation == "exec" and not record:
            raise ValueError("No separate environment registered here")
        else:
            os.execvpe(command[0], command, os.environ)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"agent-exec: {error}", file=sys.stderr)
        sys.exit(1)
