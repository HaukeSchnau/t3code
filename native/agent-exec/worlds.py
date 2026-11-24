"""Thread worlds: every repo of a world through worldfs, with this thread's own checkouts.

The worldfs daemon (native/worldfs, README.md there) owns the views, checkouts and unpushed-work
rules. agent-exec owns the thread's holder namespace, registers it with the daemon, and builds
each launch from the daemon's binds.
"""

import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import sys

import workspaces

THREAD = re.compile(r"[A-Za-z0-9._-]+")


class Refused(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def socket_path():
    return os.environ.get("WORLDFS_SOCKET") or f"/run/user/{os.getuid()}/worldfs/ctl.sock"


def call(request, path=None):
    """One request per connection, one JSON line each way (worldfs README, Control socket)."""
    path = path or socket_path()
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(120)
        try:
            connection.connect(path)
        except OSError as error:
            raise ValueError(f"The worldfs daemon is not answering at {path}: {error}") from error
        connection.sendall(json.dumps(request).encode() + b"\n")
        response = json.loads(connection.makefile("rb").readline() or b"null")
    if not isinstance(response, dict):
        raise ValueError("The worldfs daemon closed the connection without an answer")
    if not response.get("ok"):
        error = response.get("error") or {}
        raise Refused(error.get("code", "failed"), error.get("message", "worldfs refused"))
    return response


def parse_layout(text):
    layout = json.loads(text) if text else []
    if not isinstance(layout, list) or not all(
        isinstance(rule, dict) and set(rule) == {"prefix", "dir"}
        and all(isinstance(value, str) for value in rule.values())
        for rule in layout
    ):
        raise ValueError('--layout must be a JSON array of {"prefix": ..., "dir": ...}')
    return layout


def create(runtime, root, *, thread, world, path, layout, profile, project_id):
    if not THREAD.fullmatch(thread):
        raise ValueError("The thread key must be letters, digits, dot, dash or underscore")
    if not Path(path).is_absolute():
        raise ValueError("The world's path must be absolute")
    root = Path(root).expanduser().resolve()
    locks = runtime.STATE / "provision-locks"
    locks.mkdir(parents=True, exist_ok=True)
    with (locks / runtime.identity(root)).open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        wanted = {"name": world, "path": str(path), "thread": thread, "layout": layout}
        existing = runtime.lookup(root)
        if existing and existing["root"] == str(root):
            if ({key: existing.get("world", {}).get(key) for key in wanted} != wanted
                    or existing.get("projectId") != project_id
                    or existing["workspace"]["profile"] != profile):
                raise ValueError("This directory is registered with another world, thread or profile")
            register(runtime, existing)
            return existing
        if existing:
            raise ValueError("The directory is already inside a separate environment")
        if root.exists() and any(root.iterdir()):
            raise ValueError("A thread world starts in a new or empty directory")
        baseline = os.environ.get("AGENT_EXEC_BASE_PROFILE")
        if not baseline or not Path(baseline).is_dir():
            raise ValueError("This launcher does not include the Nix baseline profile")
        root.mkdir(parents=True, exist_ok=True)
        record = {
            "version": 1,
            "root": str(root),
            "home": str(Path.home()),
            "projectId": project_id,
            "workspace": {
                "id": thread,
                "name": world,
                "profile": profile,
                "baseProfile": baseline,
                "visibleRoot": str(path),
                "sourceRoot": None,
                "layout": "world",
                "ready": True,
                "sharedPackageStore": True,
                "stableRuntimePath": True,
            },
            "world": wanted,
        }
        workspaces.prepare_private_state(runtime, record, profile, baseline)
        runtime.record_path(root).parent.mkdir(parents=True, exist_ok=True)
        runtime.write_text(runtime.record_path(root), json.dumps(record) + "\n")
        # The record stays unregistered until the daemon accepts it; a retry registers again.
        register(runtime, record)
        return record


def register(runtime, record, namespace=None):
    """Registers the thread's holder; a holder restarted since the last launch moves the thread."""
    if namespace is None:
        workspaces.ensure_network(runtime, record)  # the holder's unit binds to it
        namespace = workspaces.ensure_process_namespace(runtime, record)
    world = record["world"]
    response = call({
        "method": "register", "thread": world["thread"], "world": world["name"],
        "root": record["root"], "path": world["path"], "pid": namespace["pid"],
        "layout": world["layout"],
    })
    if not world.get("registered"):
        # Only now may retire tear down this key: the daemon holds it for this root.
        set_registered(runtime, record, True)
    return response["binds"], response.get("socket") or socket_path()


def set_registered(runtime, record, registered):
    record["world"]["registered"] = registered
    runtime.write_text(runtime.record_path(record["root"]), json.dumps(record) + "\n")


def bind_arguments(binds):
    """The daemon's binds, in its order. bwrap's binds are slaves of the host's mounts, so the
    views mount that a restarted daemon puts back under <state>/mnt reaches this namespace."""
    args = []
    for entry in binds:
        args += ["--ro-bind" if entry.get("readOnly") else "--bind", entry["source"], entry["target"]]
    return args


def sync_and_exec(command):
    """Runs first in each new launch namespace, so a checkout that raced its binds reaches it."""
    try:
        call({"method": "sync"}, os.environ.pop("AGENT_EXEC_WORLD_SOCKET", None))
    except ValueError as error:
        print(f"agent-exec: this thread world could not sync with worldfs: {error}", file=sys.stderr)
        return 1
    os.execvp(command[0], command)


def loose_files(root, checkouts):
    """Files outside the thread's checkouts: no remote has them, and the daemon doesn't look."""
    if "." in checkouts:
        return []
    loose = []

    def unreadable(error):
        loose.append(str(Path(error.filename).relative_to(root)))

    for directory, children, files in os.walk(root, onerror=unreadable):
        relative = Path(directory).relative_to(root)
        children[:] = [child for child in children if str(relative / child) not in checkouts]
        loose += [str(relative / name) for name in files]
        loose += [str(relative / child) for child in children if (Path(directory) / child).is_symlink()]
    return sorted(loose)


def teardown(runtime, record):
    """Removes the thread world only when nothing in it would be lost; otherwise keeps all of it.

    The private home stays, so a thread resumed in the same ROOT keeps its provider sessions.
    """
    world, root = record["world"], Path(record["root"])
    checkouts = set()
    if world.get("registered"):
        try:
            status = call({"method": "status", "thread": world["thread"]})
        except Refused as error:
            if error.code != "unknown-thread":
                raise
            status = {"repos": []}
        checkouts = {os.path.relpath(repo["dir"], world["path"])
                     for repo in status.get("repos") or [] if repo["state"] == "checked-out"}
    loose = loose_files(root, checkouts) if root.exists() else []
    if loose:
        shown = ", ".join(loose[:10]) + (f" and {len(loose) - 10} more" if len(loose) > 10 else "")
        raise Refused("work", f"{world['path']} holds files outside its checkouts: {shown}")
    if world.get("registered"):
        # Unconfirmed before the daemon frees the key, so no retry can tear down another root
        # that takes it next. Only work and live come before the daemon releases the key; the
        # next launch confirms the record after any other failure.
        set_registered(runtime, record, False)
        try:
            call({"method": "teardown", "thread": world["thread"]})
        except Refused as error:
            if error.code in ("work", "live"):
                set_registered(runtime, record, True)
            if error.code != "unknown-thread":
                raise
    if remove_empty_tree(root):
        raise Refused("work", f"{world['path']} still holds files after teardown; nothing was removed")
    runtime.record_path(root).unlink(missing_ok=True)


def remove_empty_tree(root):
    """Removes empty directories bottom-up, never a file; true when the root is still there."""
    for directory, children, _ in os.walk(root, topdown=False):
        for child in children:
            with contextlib.suppress(OSError):
                os.rmdir(Path(directory) / child)
    with contextlib.suppress(OSError):
        root.rmdir()
    return root.exists()
