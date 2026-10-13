"""Lazy directory views with private, independent checkouts at repository boundaries."""

import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time


DISCOVERY_EXCLUDES = {
    ".git", ".jj", ".t3", ".claude", ".codex", ".direnv", ".devenv",
    ".cache", ".pnpm-store", "node_modules", "__pycache__", ".venv", "venv",
}


def repositories(source):
    """Find repository boundaries at any depth without walking their contents."""
    found = []
    for directory, children, files in os.walk(source, followlinks=False):
        if ".git" in children or ".git" in files or ".jj" in children:
            found.append(Path(directory).relative_to(source).as_posix())
            children[:] = []
        else:
            children[:] = sorted(
                name for name in children
                if name not in DISCOVERY_EXCLUDES
                and not Path(directory, name).is_symlink()
            )
    return sorted(found)


def unit_name(runtime, record):
    return "agent-workspace-files@" + runtime.identity(record["root"]) + ".service"


def ensure(runtime, record):
    if record.get("workspace", {}).get("layout") != "directory":
        return
    if os.path.ismount(record["root"]):
        return
    unit = unit_name(runtime, record)
    # These mounts outlive providers and return after login/reboot, so retained
    # workspaces remain ordinary paths for editors and T3's host-side file reads.
    runtime.run(["systemctl", "--user", "add-wants", "default.target", unit], capture_output=True)
    runtime.run(["systemctl", "--user", "start", unit], capture_output=True, timeout=30)
    if not os.path.ismount(record["root"]):
        raise ValueError("The workspace filesystem did not become ready")


def serve(runtime, record):
    """Supervise only this workspace's FUSE process and unmount it on shutdown."""
    if record.get("workspace", {}).get("layout") != "directory":
        raise ValueError("This workspace does not use a directory view")
    source = Path(record["workspace"]["sourceRoot"])
    parent = runtime.lookup(source)
    if parent:
        ensure(runtime, parent)
    if not source.is_dir():
        raise ValueError("The source directory for this workspace is unavailable")
    root = Path(record["root"])
    root.mkdir(parents=True, exist_ok=True)
    upper = runtime.project_state(record) / "files"
    upper.mkdir(exist_ok=True)
    isolate_devenv_directories(source, upper)
    # unionfs uses ':' and '=' as branch delimiters and has no escaping for them.
    if any(char in str(path) for path in (source, upper) for char in ":="):
        raise ValueError("Directory workspace paths cannot contain ':' or '='")
    child = subprocess.Popen([
        "unionfs", "-f", "-o",
        "cow,hide_meta_files,auto_cache,attr_timeout=0,entry_timeout=0,statfs_omit_ro",
        f"{upper}=RW:{source}=RO", str(root),
    ])

    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True
        child.send_signal(signum)

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, stop)
    try:
        deadline = time.monotonic() + 10
        while not os.path.ismount(root):
            if child.poll() is not None:
                raise RuntimeError("The workspace filesystem process exited before mounting")
            if time.monotonic() > deadline:
                raise TimeoutError("The workspace filesystem did not mount")
            time.sleep(0.01)
        address = os.environ["NOTIFY_SOCKET"]
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notification:
            notification.connect("\0" + address[1:] if address.startswith("@") else address)
            notification.sendall(b"READY=1")
        code = child.wait()
        # libfuse can return a positive status after its signal handler stops the loop.
        if code != 0 and not stopping:
            raise RuntimeError(f"The workspace filesystem exited with status {code}")
    finally:
        if os.path.ismount(root):
            runtime.run(["fusermount3", "-u", str(root)], timeout=15)
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)


def mask_repository(upper, relative):
    """A whiteout hides the source repo, including files absent from its clone."""
    marker = upper / ".unionfs" / (relative + "_HIDDEN~")
    marker.mkdir(parents=True, exist_ok=True)


def isolate_devenv_directory(upper, relative):
    """Hide all lower-branch cache entries, including ones absent from the upper."""
    private = upper / relative / ".devenv"
    if private.is_symlink():
        raise ValueError("Workspace .devenv state must not be a symlink")
    private.mkdir(parents=True, exist_ok=True)
    mask_repository(upper, (Path(relative) / ".devenv").as_posix())


def isolate_devenv_directories(source, upper):
    """Mask known plain-directory state before exposing the lazy filesystem."""
    for directory, children, files in os.walk(source, followlinks=False):
        if ".git" in children or ".git" in files or ".jj" in children:
            children[:] = []
            continue
        if "devenv.nix" in files or ".devenv" in children or ".devenv" in files:
            isolate_devenv_directory(upper, Path(directory).relative_to(source))
        children[:] = [name for name in children if name not in DISCOVERY_EXCLUDES
                       and not Path(directory, name).is_symlink()]


def isolate_devenv_cwd(runtime, record, cwd):
    """Also cover definitions added to a running directory view since its mount."""
    if record.get("workspace", {}).get("layout") != "directory":
        return
    root = Path(record["root"])
    cwd = Path(cwd).resolve()
    if cwd.is_relative_to(root):
        for directory in (cwd, *cwd.parents):
            if (directory / "devenv.nix").is_file():
                isolate_devenv_directory(runtime.project_state(record) / "files", directory.relative_to(root))
                break
            if directory == root:
                break


def remove_checkout(runtime, record):
    root = Path(record["root"])
    for file in (runtime.STATE / "projects").glob("*.json"):
        dependent = json.loads(file.read_text())
        source = dependent.get("workspace", {}).get("sourceRoot")
        if (dependent["root"] != str(root) and source
                and dependent.get("workspace", {}).get("layout") == "directory"
                and Path(source).is_relative_to(root)):
            raise ValueError("Another workspace still reads files from this workspace")
    if record.get("workspace", {}).get("layout") == "directory":
        unit = unit_name(runtime, record)
        runtime.run(["systemctl", "--user", "stop", unit], capture_output=True)
        runtime.run(["systemctl", "--user", "disable", unit], capture_output=True)
        if os.path.ismount(root):
            raise ValueError("The workspace filesystem is still mounted")
        shutil.rmtree(runtime.project_state(record) / "files", ignore_errors=False)
    if root.exists():
        shutil.rmtree(root)
    runtime.record_path(root).unlink(missing_ok=True)
