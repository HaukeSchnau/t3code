"""Opt-in independent jj workspaces, private networking, and pinned tool profiles."""

import contextlib
import hashlib
import json
import os
from pathlib import Path
import project_files
import re
import shlex
import shutil
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import tomllib
import tool_environments
import devenv_environment
import uuid


def jj(root, *args, snapshot=False):
    command = ["jj", "--no-pager", "--color=never", "--repository", str(root)]
    if not snapshot:
        command += ["--ignore-working-copy"]
    result = subprocess.run(
        [
            *command,
            "--config",
            "git.abandon-unreachable-commits=false",
            "--config",
            "revsets.short-prefixes=all()",
            *args,
        ],
        text=True,
        capture_output=True,
        timeout=180,
    )
    if result.returncode:
        raise ValueError(result.stderr.strip())
    return result.stdout.strip()


def git(root, *args):
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        text=True,
        capture_output=True,
        timeout=180,
    )
    if result.returncode:
        raise ValueError(result.stderr.strip())
    return result.stdout.strip()


def uses_jj(root):
    return subprocess.run(
        ["jj", "--ignore-working-copy", "--repository", str(root), "root"],
        capture_output=True,
        timeout=30,
    ).returncode == 0


@contextlib.contextmanager
def exported_revision(source, revision):
    # A private temporary ref transports the selected immutable snapshot. It
    # does not edit/rebase the source working copy or move its existing bookmarks.
    source_uses_jj = uses_jj(source)
    commit = (
        jj(source, "log", "-r", revision, "--no-graph", "-T", "commit_id", snapshot=True)
        if source_uses_jj
        else git(source, "rev-parse", "--verify", "--end-of-options", revision + "^{commit}")
    )
    if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        raise ValueError("Choose exactly one source revision")
    bookmark = "agent-transfer-" + uuid.uuid4().hex
    if source_uses_jj:
        jj(source, "bookmark", "create", bookmark, "-r", commit)
        jj(source, "git", "export")
    else:
        git(source, "update-ref", "refs/heads/" + bookmark, commit)
    try:
        yield bookmark, commit
    finally:
        if source_uses_jj:
            jj(source, "bookmark", "delete", bookmark)
            jj(source, "git", "export")
        else:
            git(source, "update-ref", "-d", "refs/heads/" + bookmark, commit)


def repository_directory(source):
    # A jj workspace may store its Git repository outside its checkout.
    return jj(source, "git", "root") if uses_jj(source) else git(source, "rev-parse", "--absolute-git-dir")


def inherit_remotes(source, destination):
    """Copy remote endpoints/refspecs, never source hooks or other repository config."""
    result = subprocess.run(
        ["git", "--git-dir", repository_directory(source), "config", "--null",
         "--get-regexp", r"^remote\..*\.(url|pushurl|fetch|push|tagopt)$"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode not in (0, 1):
        raise ValueError(result.stderr.strip())
    existing = set(git(destination, "remote").splitlines())
    for entry in result.stdout.split("\0"):
        if not entry:
            continue
        key, value = entry.split("\n", 1)
        name, field = key[len("remote."):].rsplit(".", 1)
        # Repairs may add missing remotes but must preserve workspace overrides.
        if name in existing:
            continue
        if field in ("url", "pushurl") and not re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:|[^/]+:", value):
            value = str((Path(source) / value).resolve())
        git(destination, "config", "--local", "--add", key, value)


def fork_repository(source, destination, revision):
    with exported_revision(source, revision) as (bookmark, commit):
        cloned = subprocess.run(
            [
                "jj", "--config", "revsets.short-prefixes=all()", "git", "clone",
                "--colocate", "--remote", "seed", "--branch", bookmark,
                repository_directory(source), str(destination),
            ],
            capture_output=True, text=True, timeout=180,
        )
        if cloned.returncode:
            raise ValueError(f"Could not fork repository {source}: {cloned.stderr.strip()}")
        jj(destination, "bookmark", "create", "main", "-r", commit)
        jj(destination, "git", "remote", "remove", "seed")
    inherit_remotes(source, destination)
    jj(destination, "config", "set", "--repo", "git.write-change-id-header", "true")
    return commit


def fork(runtime, source, destination, name, revision, profile, *, workspace_id=None, project_id=None):
    import fcntl

    locks = runtime.STATE / "provision-locks"
    locks.mkdir(parents=True, exist_ok=True)
    with (locks / runtime.identity(Path(destination).expanduser().resolve())).open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return prepare_fork(runtime, source, destination, name, revision, profile,
                            workspace_id=workspace_id, project_id=project_id)


def prepare_fork(runtime, source, destination, name, revision, profile, *, workspace_id=None, project_id=None):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", name):
        raise ValueError("Use a short project name without directory separators")
    source, destination = (
        Path(source).resolve(),
        Path(destination).expanduser().resolve(),
    )
    existing = runtime.lookup(destination)
    if workspace_id and existing and existing["root"] == str(destination):
        workspace = existing.get("workspace", {})
        if (
            workspace.get("id") == workspace_id
            and workspace.get("name") == name
            and workspace.get("sourceRoot") == str(source)
            and workspace.get("requestedRevision") == revision
            and workspace.get("profile") == profile
            and existing.get("projectId") == project_id
        ):
            if not destination.is_dir():
                raise ValueError("The registered workspace directory is missing")
            if workspace.get("ready", True):
                project_files.ensure(runtime, existing)
                return existing
            return finish_directory_fork(runtime, existing)
        raise ValueError("Workspace registration does not match this creation request")
    if destination.exists():
        raise ValueError(
            "The destination must not exist; existing projects are never replaced"
        )
    if existing:
        raise ValueError("The destination is already inside a separate environment")
    baseline = os.environ.get("AGENT_EXEC_BASE_PROFILE")
    if not baseline or not Path(baseline).is_dir():
        raise ValueError("This launcher does not include the Nix baseline profile")
    source_record = runtime.lookup(source)
    if source_record:
        project_files.ensure(runtime, source_record)
    if not source.is_dir():
        raise ValueError("The source project must be an existing directory")
    is_repository = uses_jj(source) or subprocess.run(
        ["git", "-C", str(source), "rev-parse", "--git-dir"],
        capture_output=True, timeout=30,
    ).returncode == 0
    if not is_repository:
        if source in {Path("/"), Path.home(), runtime.STATE} or destination.is_relative_to(source):
            raise ValueError("Choose a project directory outside the managed workspace storage")
        if revision not in ("@", "HEAD"):
            raise ValueError("Directory projects use each repository's current revision")
        discovered = project_files.repositories(source)
        commit = None
        destination.mkdir(parents=True)
    else:
        discovered = []
        commit = fork_repository(source, destination, revision)
    record = {
        "version": 1,
        "root": str(destination),
        "home": str(Path.home()),
        "infra": str(Path.home() / "infra"),
        "projectId": project_id,
        "workspace": {
            "id": workspace_id,
            "name": name,
            "profile": profile,
            "baseProfile": baseline,
            "visibleRoot": str(Path.home() / name),
            "sourceRevision": commit,
            "sourceRoot": str(source),
            "requestedRevision": revision,
            "layout": "repository" if is_repository else "directory",
            "ready": is_repository,
            "sharedPackageStore": True,
            "stableRuntimePath": True,
            "repositories": [
                {"path": path, "sourceRevision": None} for path in discovered
            ],
        },
    }
    state = runtime.project_state(record)
    state.mkdir(parents=True, exist_ok=True)
    profile_dir = state / "profile"
    profile_dir.mkdir(exist_ok=True)
    for name, source_file in [
        ("codex.md", Path.home() / ".codex/AGENTS.md"),
        ("claude.md", Path.home() / ".claude/CLAUDE.md"),
    ]:
        (profile_dir / name).write_text(
            source_file.read_text()
            if profile == "familiar" and source_file.exists()
            else ""
        )
    # GC roots keep pinned profiles usable across host upgrades.
    if not (state / "base-profile").is_symlink():
        (state / "base-profile").symlink_to(baseline)
    pin_profile(state, baseline)
    runtime.record_path(destination).parent.mkdir(parents=True, exist_ok=True)
    runtime.write_text(runtime.record_path(destination), json.dumps(record) + "\n")
    if not is_repository:
        return finish_directory_fork(runtime, record)
    finish_legacy_configuration(runtime, record)
    return record


def finish_legacy_configuration(runtime, record):
    # T3-owned workspaces keep the source project's configuration unchanged.
    if record["workspace"]["id"] is None:
        t3_file = Path(record["root"]) / "t3.json"
        t3_config = json.loads(t3_file.read_text()) if t3_file.exists() else {}
        t3_config["defaultThreadEnvMode"] = "local"
        runtime.write_text(t3_file, json.dumps(t3_config, indent=2) + "\n")


def finish_directory_fork(runtime, record):
    from concurrent.futures import ThreadPoolExecutor
    import threading

    state = runtime.project_state(record)
    upper = state / "files"
    upper.mkdir(exist_ok=True)
    staging = state / "repository-staging"
    staging.mkdir(exist_ok=True)
    revisions = state / "repository-revisions"
    revisions.mkdir(exist_ok=True)
    workspace = record["workspace"]
    save_lock = threading.Lock()

    def prepare(repository):
        relative = repository["path"]
        project_files.mask_repository(upper, relative)
        checkout = upper / relative
        marker = revisions / runtime.identity(relative)
        if not checkout.exists() or not marker.exists():
            source = Path(workspace["sourceRoot"]) / relative
            temporary = staging / runtime.identity(relative)
            if temporary.exists():
                shutil.rmtree(temporary)
            revision = "@" if uses_jj(source) else "HEAD"
            commit = fork_repository(source, temporary, revision)
            runtime.write_text(marker, commit)
            checkout.parent.mkdir(parents=True, exist_ok=True)
            temporary.rename(checkout)
        with save_lock:
            repository["sourceRevision"] = marker.read_text()
            runtime.write_text(runtime.record_path(record["root"]), json.dumps(record) + "\n")

    # Bound process and disk pressure even when a project contains hundreds of repos.
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(prepare, workspace["repositories"]))
    workspace["ready"] = True
    runtime.write_text(runtime.record_path(record["root"]), json.dumps(record) + "\n")
    project_files.ensure(runtime, record)
    finish_legacy_configuration(runtime, record)
    return record


def pin_profile(state, baseline):
    subprocess.run(
        [
            "nix-store",
            "--add-root",
            str(state / "profile-root"),
            "--indirect",
            "--realise",
            baseline,
        ],
        check=True,
        capture_output=True,
    )


def provider_config(source, destination):
    """Keep provider connection settings without exposing unrelated project registrations."""
    import tomli_w

    config = tomllib.loads(source.read_text()) if source.exists() else {}
    for key in ["projects", "history", "memories", "marketplaces", "tui", "notice"]:
        config.pop(key, None)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=destination.parent, delete=False
    ) as output:
        output.write(tomli_w.dumps(config))
        temporary = Path(output.name)
    temporary.replace(destination)


def collect(source, destination, revision):
    with exported_revision(source, revision) as (bookmark, commit):
        incoming = "incoming/" + uuid.uuid4().hex[:12]
        if not uses_jj(destination):
            git(
                destination, "fetch", "--no-tags", "--no-write-fetch-head",
                repository_directory(source),
                "refs/heads/" + bookmark + ":refs/heads/" + incoming,
            )
            return {"bookmark": incoming, "commit": commit, "change": None}
        remote = "transfer-" + uuid.uuid4().hex
        jj(destination, "git", "remote", "add", remote, repository_directory(source))
        try:
            jj(destination, "git", "fetch", "--remote", remote, "--branch", bookmark)
            jj(destination, "bookmark", "create", incoming, "-r", commit)
        finally:
            jj(destination, "git", "remote", "remove", remote)
    return {
        "bookmark": incoming,
        "commit": commit,
        "change": jj(destination, "log", "-r", commit, "--no-graph", "-T", "change_id"),
    }


def visible_root(record):
    return record.get("workspace", {}).get("visibleRoot", record["root"])


def host_path(runtime, record, path):
    """Translate namespace paths using this registration, never a sibling's state."""
    path = Path(os.path.normpath(path))
    state = runtime.project_state(record)
    mappings = [
        (Path(visible_root(record)), Path(record["root"])),
        (Path("/tmp"), state / "tmp"),
        (Path("/srv/agent-share"), runtime.publish_directory(record)),
        (Path(record["home"]), state / "home"),
    ]
    if record.get("workspace", {}).get("stableRuntimePath") and path.is_relative_to("/tmp/runtime"):
        namespace = json.loads((state / "process-namespace.json").read_text())
        mappings.insert(0, (Path("/tmp/runtime"), state / "tmp" / namespace["runtime"].removeprefix("/tmp/")))
    # Host paths are accepted for T3's provider startup and native account results.
    for root in [Path(record["root"]), state, runtime.publish_directory(record)]:
        if path.is_relative_to(root):
            return path
    for visible, actual in mappings:
        if path.is_relative_to(visible):
            return actual / path.relative_to(visible)
    raise ValueError("Path is not part of this environment")


def network_unit(runtime, record):
    return "agent-net-" + runtime.identity(record["root"])


def ensure_network(runtime, record):
    unit = network_unit(runtime, record)
    state = runtime.project_state(record)
    import fcntl

    with (state / "network-lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", unit])
        if active.returncode:
            runtime.run(
                [
                    "systemd-run",
                    "--user",
                    "--quiet",
                    "--collect",
                    "--unit",
                    unit,
                    "--slice=agent-env-" + runtime.identity(record["root"]) + ".slice",
                    "--property=Type=notify",
                    "--property=TimeoutStartSec=30",
                    "--property=MemoryMax=256M",
                    "--property=TasksMax=32",
                    "--setenv=AGENT_EXEC_STATE=" + str(runtime.STATE),
                    runtime.LAUNCHER,
                    "network",
                    "--root",
                    record["root"],
                ]
            )
            runtime.run(
                [
                    "systemctl",
                    "--user",
                    "set-property",
                    "--runtime",
                    "agent-env-" + runtime.identity(record["root"]) + ".slice",
                    "MemoryMax=8G",
                    "TasksMax=2048",
                    "CPUWeight=50",
                ]
            )
    pid = int((state / "network-pid").read_text())
    return [
        "nsenter",
        f"--user=/proc/{pid}/ns/user",
        f"--net=/proc/{pid}/ns/net",
        "--preserve-credentials",
    ]


def network(runtime, record):
    state = runtime.project_state(record)
    api = state / "network.sock"
    api.unlink(missing_ok=True)
    holder = subprocess.Popen(
        ["unshare", "--user", "--map-current-user", "--net", "sleep", "infinity"]
    )
    slirp = None
    read_fd, write_fd = os.pipe()
    try:
        # unshare execs sleep, so this PID remains the namespace owner. Wait for
        # the namespace transition, not merely for successful process creation.
        import time

        host_ns = os.readlink("/proc/self/ns/net")
        deadline = time.monotonic() + 10
        while os.readlink(f"/proc/{holder.pid}/ns/net") == host_ns:
            if holder.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("Network namespace did not start")
            time.sleep(0.01)
        slirp = subprocess.Popen(
            [
                "slirp4netns",
                "--configure",
                "--ready-fd",
                str(write_fd),
                "--api-socket",
                str(api),
                str(holder.pid),
                "tap0",
            ],
            pass_fds=[write_fd],
        )
        os.close(write_fd)
        write_fd = None
        if not select.select([read_fd], [], [], 20)[0] or os.read(read_fd, 1) != b"1":
            raise RuntimeError("Outbound network did not become ready")
        runtime.write_text(state / "network-pid", str(holder.pid))
        # Send from the service's main process; a helper child is not accepted
        # by Type=notify's default NotifyAccess=main policy.
        address = os.environ["NOTIFY_SOCKET"]
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notification:
            notification.connect(
                "\0" + address[1:] if address.startswith("@") else address
            )
            notification.sendall(b"READY=1")
        slirp.wait()
    finally:
        for process in [slirp, holder]:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)
        api.unlink(missing_ok=True)
        (state / "network-pid").unlink(missing_ok=True)


def run_scope(command, unit, namespace_fds):
    """Reap command descendants on exit, even though workspace PIDs are shared."""
    child = None
    interrupted = None

    def stop(signum, frame):
        nonlocal interrupted
        interrupted = signum
        if child and child.poll() is None:
            child.send_signal(signum)

    previous = {signum: signal.signal(signum, stop)
                for signum in [signal.SIGTERM, signal.SIGINT]}
    try:
        child = subprocess.Popen(command, pass_fds=namespace_fds)
        if interrupted:
            child.send_signal(interrupted)
        code = child.wait()
        return 128 - code if code < 0 else code
    finally:
        if unit is not None:
            subprocess.run(["systemctl", "--user", "stop", unit],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        for fd in namespace_fds:
            os.close(fd)
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def ensure_process_namespace(runtime, record):
    """Commands sharing sockets and PID files must also share process IDs."""
    state = runtime.project_state(record)
    unit = "agent-pid-" + runtime.identity(record["root"])
    import fcntl

    with (state / "process-lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", unit])
        if active.returncode:
            runtime.run([
                "systemd-run", "--user", "--quiet", "--collect", "--unit", unit,
                "--slice=agent-env-" + runtime.identity(record["root"]) + ".slice",
                "--property=Type=notify", "--property=TimeoutStartSec=20",
                "--property=BindsTo=" + network_unit(runtime, record) + ".service",
                "--property=After=" + network_unit(runtime, record) + ".service",
                "--setenv=AGENT_EXEC_STATE=" + str(runtime.STATE),
                runtime.LAUNCHER, "process-namespace", "--root", record["root"],
            ])
    return json.loads((state / "process-namespace.json").read_text())


def process_namespace(runtime, record):
    import time

    state = runtime.project_state(record)
    holder = subprocess.Popen([
        *ensure_network(runtime, record), "--keep-caps",
        "unshare", "--user", "--map-current-user", "--pid", "--fork",
        "--kill-child", "--forward-signals", "tini", "--", "sleep", "infinity",
    ])
    def stop(signum, frame):
        if holder.poll() is None:
            holder.send_signal(signum)

    for signum in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(signum, stop)
    runtime_directory = "/tmp/runtime/" + uuid.uuid4().hex[:12]
    directory = state / "tmp" / runtime_directory.removeprefix("/tmp/")
    try:
        # pid_for_children becomes usable only after the namespace init exists.
        host_ns = os.readlink("/proc/self/ns/pid")
        deadline = time.monotonic() + 10
        while True:
            try:
                ready = os.readlink(f"/proc/{holder.pid}/ns/pid_for_children") != host_ns
            except FileNotFoundError:
                ready = False
            if ready:
                break
            if holder.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("Process namespace did not start")
            time.sleep(0.01)
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        runtime.write_text(state / "process-namespace.json", json.dumps({
            "pid": holder.pid, "runtime": runtime_directory,
        }))
        address = os.environ["NOTIFY_SOCKET"]
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notification:
            notification.connect("\0" + address[1:] if address.startswith("@") else address)
            notification.sendall(b"READY=1")
        holder.wait()
    finally:
        if holder.poll() is None:
            holder.terminate()
            holder.wait(timeout=5)
        (state / "process-namespace.json").unlink(missing_ok=True)
        shutil.rmtree(directory, ignore_errors=True)


def forwarding(runtime, record, operation, arguments=None):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(10)
        connection.connect(str(runtime.project_state(record) / "network.sock"))
        connection.sendall(
            json.dumps({"execute": operation, "arguments": arguments or {}}).encode()
        )
        connection.shutdown(socket.SHUT_WR)
        data = b""
        while chunk := connection.recv(65536):
            data += chunk
    result = json.loads(data)
    if "error" in result:
        raise ValueError(str(result["error"]))
    return result.get("return", result)


def service(runtime, record, cwd, port, command):
    ensure_network(runtime, record)
    host_port = int(os.environ["PORT"])
    entry = forwarding(
        runtime,
        record,
        "add_hostfwd",
        {
            "proto": "tcp",
            "host_addr": "127.0.0.1",
            "host_port": host_port,
            "guest_addr": "10.0.2.100",
            "guest_port": port,
        },
    )
    child = None

    def stop(signum, frame):
        if child:
            child.send_signal(signum)

    for signum in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(signum, stop)
    try:
        child = subprocess.Popen(
            [runtime.LAUNCHER, "exec", "--cwd", cwd, "--", *command],
            env={**os.environ, "PORT": str(port), "HOST": "0.0.0.0"},
        )
        return child.wait()
    finally:
        forwarding(runtime, record, "remove_hostfwd", {"id": entry["id"]})


def activate(command):
    """Runs inside the namespace; environment evaluation sees the same paths as tools."""
    root = Path(os.environ["AGENT_EXEC_ROOT"])
    cache = Path(os.environ["AGENT_EXEC_TOOL_CACHE"])
    cwd = Path.cwd()
    if os.environ.get("AGENT_EXEC_ACTIVATING") or os.environ.get("DEVENV_TASK_OUTPUT_FILE"):
        # Native task commands and package-manager hooks may invoke /bin/sh.
        # They already have the environment supplied by devenv's task runner.
        if command[0] in ["bash", "sh", "/bin/bash", "/bin/sh"]:
            command[0] = os.environ["AGENT_EXEC_REAL_BASH"]
        os.execvpe(command[0], command, dict(os.environ))
        return
    selected_root, backend = devenv_environment.definition(
        root, cwd, os.environ.get("AGENT_EXEC_ENVIRONMENT", "auto")
    )
    if selected_root != root:
        cache = cache / "nested" / hashlib.sha256(str(selected_root.relative_to(root)).encode()).hexdigest()[:20]
    root = selected_root
    if (root / ".devenv/agent-exec-baseline").is_file():
        print("agent-exec: baseline repair mode; delete "
              + str(root / ".devenv/agent-exec-baseline") + " to restore project setup", file=sys.stderr)
        backend = "baseline"
    cache.mkdir(parents=True, exist_ok=True)
    base_path = os.environ["AGENT_EXEC_BASE_PATH"]
    env = dict(os.environ)
    # Nested shells re-enter with their parent's environment. Remove values
    # owned by its previous definition before evaluating the current one.
    for name in env.pop("AGENT_EXEC_PROJECT_VARIABLES", "").split(":"):
        if name and environment_variable(name):
            env.pop(name, None)
    caller_path = os.environ.get("PATH", "")
    previous_environment_path = env.get("AGENT_EXEC_ENVIRONMENT_PATH")
    env["PATH"] = base_path
    fingerprint = hashlib.sha256(b"git-aware-flake-v1")
    # Imported Nix files affect the environment too. Do not scan dependencies,
    # provider state, or symlinks to unrelated filesystem trees.
    hook = ""
    task_exports = {}
    if backend == "devenv":
        if env.get("AGENT_EXEC_WORKSPACE_LAYOUT") == "directory":
            subprocess.run(
                [os.environ["AGENT_EXEC_LAUNCHER"], "request", "environment-root", str(root)],
                env=env, check=True, timeout=30,
            )
        current_environment, task_exports = devenv_environment.evaluate(root, cache, env)
        for name, value in current_environment.get("variables", {}).items():
            if value.get("type") == "exported" and environment_variable(name):
                env[name] = value["value"]
        env["PATH"] = "/run/agent-exec-bin:" + env.get("PATH", "") + ":" + base_path
        hook = current_environment.get("variables", {}).get("shellHook", {}).get("value", "")
        env["AGENT_EXEC_PROJECT_VARIABLES"] = ":".join(sorted(
            name for name in set(current_environment.get("variables", {})) | set(task_exports)
            if environment_variable(name)
        ))
    elif backend == "flake":
        tool_environments.snapshot_untracked_files(root, cache, base_path)
        shared = os.environ.get("AGENT_EXEC_SHARED_TOOL_CACHE")
        shared_key = tool_environments.tracked_fingerprint(root, base_path) if shared else None
        for directory, children, files in (() if shared_key else os.walk(root)):
            children[:] = sorted(
                n
                for n in children
                if n
                not in {
                    ".git",
                    ".jj",
                    ".direnv",
                    ".devenv",
                    "node_modules",
                    ".pnpm-store",
                    ".t3",
                    "dist",
                    ".next",
                }
                and not n.startswith(".agent-environment")
            )
            for name in sorted(files):
                file = Path(directory) / name
                if (
                    name.endswith(".nix") or file == root / "flake.lock"
                ) and not file.is_symlink():
                    fingerprint.update(str(file.relative_to(root)).encode())
                    fingerprint.update(file.read_bytes())
        key = shared_key or fingerprint.hexdigest()
        generation = Path(shared) / shared_key if shared and shared_key else None
        if generation:
            generation.mkdir(parents=True, exist_ok=True)
        previous = cache / "current.json"
        current = json.loads(previous.read_text()) if previous.exists() else {}
        failure = cache / "failure.json"
        cached_error = recent_failure(cache, key) if current.get("fingerprint") != key else None
        if cached_error is not None:
            print(environment_failure(root, cache, cached_error), file=sys.stderr)
        elif current.get("fingerprint") != key:
            import fcntl

            with ((generation or cache) / "lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                current = json.loads(previous.read_text()) if previous.exists() else {}
                shared_result = generation / "environment.json" if generation else None
                if shared_result and shared_result.exists():
                    current = {"fingerprint": key, "environment": json.loads(shared_result.read_text())}
                    temporary = cache / "next.json"
                    temporary.write_text(json.dumps(current))
                    temporary.replace(previous)
                    (cache / "error").unlink(missing_ok=True)
                    failure.unlink(missing_ok=True)
                if current.get("fingerprint") != key:
                    result = subprocess.run(
                        [
                            "nix",
                            "print-dev-env",
                            "--json",
                            "--no-write-lock-file",
                            "--profile",
                            str((generation or cache) / "profile"),
                            # Let Nix filter Git checkouts to tracked files;
                            # path: includes metadata such as fsmonitor sockets.
                            str(root) + "#default",
                        ],
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=300,
                    )
                    if result.returncode == 0:
                        current = {
                            "fingerprint": key,
                            "environment": json.loads(result.stdout),
                        }
                        inputs_unchanged = not generation or tool_environments.tracked_fingerprint(root, base_path) == key
                        if not inputs_unchanged:
                            current["fingerprint"] = "changed-during-evaluation"
                        if shared_result and inputs_unchanged:
                            temporary = generation / "next.json"
                            temporary.write_text(json.dumps(current["environment"]))
                            temporary.replace(shared_result)
                            tool_environments.prune_generations(generation.parent)
                        temporary = cache / "next.json"
                        temporary.write_text(json.dumps(current))
                        temporary.replace(previous)
                        (cache / "error").unlink(missing_ok=True)
                        failure.unlink(missing_ok=True)
                    else:
                        (cache / "error").write_text(result.stderr)
                        failure.write_text(json.dumps({"fingerprint": key, "at": time.time()}))
                        print(environment_failure(root, cache, result.stderr), file=sys.stderr)
        for name, value in current.get("environment", {}).get("variables", {}).items():
            if (
                value.get("type") == "exported"
                and environment_variable(name)
            ):
                env[name] = value["value"]
        env["PATH"] = "/run/agent-exec-bin:" + env.get("PATH", "") + ":" + base_path
        hook = (
            current.get("environment", {})
            .get("variables", {})
            .get("shellHook", {})
            .get("value", "")
        )
    # Nested package-manager shells add local executables to PATH. Retain those
    # additions while replacing the previous Nix tool paths on environment refresh.
    environment_path = env["PATH"]
    additions = []
    if previous_environment_path is not None:
        previous_entries = set(previous_environment_path.split(os.pathsep))
        additions = [entry for entry in caller_path.split(os.pathsep) if entry not in previous_entries]
        if backend != "devenv":
            env["PATH"] = os.pathsep.join([*additions, environment_path])
    env["AGENT_EXEC_ENVIRONMENT_PATH"] = environment_path
    env["SHELL"] = "/bin/bash"
    if command[0] in ["bash", "sh", "/bin/bash", "/bin/sh"]:
        command[0] = os.environ["AGENT_EXEC_REAL_BASH"]
    if backend == "devenv":
        # Hooks run at the environment root and write to diagnostics. Task
        # exports take precedence, matching native shell entry, then restore cwd.
        exports = "\n".join(
            "export " + name + "=" + shlex.quote(value)
            for name, value in task_exports.items() if environment_variable(name)
        )
        env["AGENT_EXEC_ACTIVATING"] = str(root)
        hook = (
            "cd " + shlex.quote(str(root)) + "\n{\n" + hook + "\n} >&2\n"
            + exports + "\ncd " + shlex.quote(str(cwd))
            + '\nexport PATH="/run/agent-exec-bin:$PATH":' + shlex.quote(base_path)
            + '\nexport AGENT_EXEC_ENVIRONMENT_PATH="$PATH"'
            + ("\nexport PATH=" + shlex.quote(os.pathsep.join(additions)) + ':"$PATH"' if additions else "")
            + "\nunset AGENT_EXEC_ACTIVATING"
        )
    if hook:
        command = [
            os.environ["AGENT_EXEC_REAL_BASH"],
            "--noprofile",
            "--norc",
            "-c",
            hook + '\nexec "$@"',
            "agent-environment",
            *command,
        ]
    os.execvpe(command[0], command, env)


FAILURE_RETRY_SECONDS = 60


def recent_failure(cache, key):
    """Return the saved error while a failed key waits to retry; changed inputs retry at once.

    The wait still lets transient failures, such as network errors, recover on their own.
    """
    try:
        failure = json.loads((cache / "failure.json").read_text())
        error = (cache / "error").read_text()
    except (OSError, ValueError):
        return None
    if failure.get("fingerprint") != key or time.time() - failure.get("at", 0) >= FAILURE_RETRY_SECONDS:
        return None
    return error


def environment_failure(root, cache, stderr):
    """Summarize a failed evaluation with Nix's final error and the full log's visible path."""
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    errors = [index for index, line in enumerate(lines) if line.startswith("error:")]
    summary = lines[errors[-1]:][:6] if errors else lines[-6:]
    if "is not tracked by Git" in stderr and tool_environments.colocated_jj_repository(root):
        summary.append("In this jj repository, run `jj st` instead to track new files; it reports why a snapshot fails.")
    # The tool cache is also mounted at ~/.local/state/agent-environment.
    visible = Path("~/.local/state/agent-environment") / (cache / "error").relative_to(
        os.environ["AGENT_EXEC_TOOL_CACHE"]
    )
    return "\n".join([
        "agent-exec: project environment could not be rebuilt; using previous tools.",
        *("  " + line for line in summary),
        f"Full log: {visible}. Retrying after {FAILURE_RETRY_SECONDS} s or when project files change.",
    ])


def environment_variable(name):
    """Keep namespace paths and launcher controls outside project activation."""
    return (
        name not in {"HOME", "PWD", "OLDPWD", "TMPDIR", "TEMP", "TMP", "TEMPDIR", "BASH_ENV", "SHELL"}
        and not name.startswith("AGENT_EXEC_")
        and name.isascii() and name.replace("_", "a").isalnum() and not name[0].isdigit()
    )
