"""Native devenv tasks and evaluation, with strict automatic-entry semantics."""

import fcntl
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import sqlite3
import subprocess
import sys
import time
import tempfile


SETUP_TIMEOUT = 900
PROGRESS_INTERVAL = 15


def snapshot_evaluation_cache(source, destination):
    """Copy a consistent SQLite snapshot, including committed WAL data, atomically."""
    if not source.is_file():
        return
    temporary = None
    started = time.monotonic()

    def progress(*_):
        if time.monotonic() - started > 5:
            raise TimeoutError("evaluation cache snapshot timed out")

    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as file:
            temporary = Path(file.name)
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as source_db:
            with closing(sqlite3.connect(temporary)) as destination_db:
                source_db.backup(destination_db, pages=256, progress=progress, sleep=0.01)
                destination_db.execute("PRAGMA journal_mode=DELETE")
        temporary.replace(destination)
    except (OSError, sqlite3.Error, TimeoutError) as error:
        # This is only a cache hint; native evaluation remains authoritative.
        print(f"agent-exec: evaluation cache snapshot skipped: {error}", file=sys.stderr)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def seed_evaluation_cache(root, env):
    """Seed only evaluation observations, never task success or mutable workspace state."""
    shared = env.get("AGENT_EXEC_SHARED_DEVENV_CACHE")
    database = root / ".devenv/nix-eval-cache.db"
    if not shared or database.exists():
        return None
    key = hashlib.sha256((str(root) + "\0" + os.environ["AGENT_EXEC_DEVENV"]).encode()).hexdigest()
    snapshot = Path(shared) / (key + ".sqlite")
    snapshot_evaluation_cache(snapshot, database)
    return database, snapshot


def repair_command(root, env):
    marker = root / ".devenv/agent-exec-baseline"
    if env.get("AGENT_EXEC_HOST_ROOT") and env.get("AGENT_EXEC_ROOT"):
        root = Path(env["AGENT_EXEC_HOST_ROOT"]) / root.relative_to(env["AGENT_EXEC_ROOT"])
    return (f"agent-exec exec --cwd {shlex.quote(str(root))} --environment baseline -- bash"
            + "\nIf shell entry itself is blocked, use an editor/file tool to create "
            + str(marker)
            + ". Shells will skip project setup until you delete that file.")


def wait_interval(start, timeout, phase):
    elapsed = time.monotonic() - start
    if elapsed >= timeout:
        raise TimeoutError(f"{phase} timed out after {timeout:g}s")
    return min(PROGRESS_INTERVAL, timeout - elapsed)


def progress(start, timeout, phase):
    print(f"agent-exec: {phase} ({time.monotonic() - start:.0f}s elapsed; limit {timeout:g}s)",
          file=sys.stderr, flush=True)


def run_native(command, root, env, timeout, phase):
    """Keep JSON on stdout private; show setup output only when the step fails or is stopped."""
    start = time.monotonic()
    child = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        while True:
            try:
                stdout, stderr = child.communicate(timeout=wait_interval(start, timeout, phase))
                if child.returncode:
                    report_setup_output(stderr)
                return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
            except subprocess.TimeoutExpired:
                wait_interval(start, timeout, phase)
                progress(start, timeout, phase)
    except BaseException:
        # The native task runner can have package-manager children holding pipes.
        # Cancel the whole setup group before releasing the workspace entry lock.
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            _, stderr = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            _, stderr = child.communicate()
        report_setup_output(stderr)
        raise


def report_setup_output(stderr):
    """Warm entries stay quiet; a failed or stopped step replays what devenv printed."""
    if stderr:
        sys.stderr.write(stderr if stderr.endswith("\n") else stderr + "\n")
        sys.stderr.flush()


def acquire_entry_lock(lock, timeout):
    """Serialize setup without hiding a competing entry or waiting indefinitely."""
    start = time.monotonic()
    next_progress = start + PROGRESS_INTERVAL
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            interval = wait_interval(start, timeout, "waiting for another workspace setup")
            if time.monotonic() >= next_progress:
                progress(start, timeout, "waiting for another workspace setup")
                next_progress = time.monotonic() + PROGRESS_INTERVAL
            time.sleep(min(0.1, interval))


def definition(root, cwd, backend="auto"):
    """The nearest definition wins; devenv takes precedence beside a release flake."""
    if backend not in {"auto", "devenv", "flake", "baseline"}:
        raise ValueError("Environment must be auto, devenv, flake, or baseline")
    if backend == "baseline":
        return root, "baseline"
    candidates = (cwd, *cwd.parents) if cwd.is_relative_to(root) else (root,)
    for candidate in candidates:
        for kind, filename in [("devenv", "devenv.nix"), ("flake", "flake.nix")]:
            if backend in {"auto", kind} and (candidate / filename).is_file():
                return candidate, kind
        if candidate == root:
            break
    if backend != "auto":
        raise ValueError(f"No {backend} environment found between {cwd} and {root}")
    return root, "baseline"


def evaluate(root, cache, env):
    """Run setup once, then read the native environment after any task-generated inputs."""
    timeout = int(env.get("AGENT_EXEC_SETUP_TIMEOUT", SETUP_TIMEOUT))
    if timeout <= 0:
        raise ValueError("--setup-timeout must be a positive number of seconds")
    # Native devenv owns lock creation/reconciliation from declared inputs.
    # Freezing it here prevents new projects from reaching their first shell.
    command = [
        os.environ["AGENT_EXEC_BWRAP"], "--die-with-parent", "--unshare-pid", "--bind", "/", "/",
        "--dev-bind", "/dev", "/dev", "--proc", "/proc",
        "--",
        os.environ["AGENT_EXEC_DEVENV"], "--no-tui", "--no-reload",
    ]
    activation_env = {**env, "AGENT_EXEC_ACTIVATING": str(root)}

    def native(phase, *arguments):
        result = run_native([*command, *arguments], root, activation_env, timeout, phase)
        if result.returncode:
            raise ValueError(
                f"devenv {' '.join(arguments)} failed with status {result.returncode}; "
                "see the setup output above"
            )
        return json.loads(result.stdout)

    cache.mkdir(parents=True, exist_ok=True)
    lock_file = root / "devenv.lock"
    lock_before = lock_file.read_bytes() if lock_file.is_file() else None
    with (cache / "devenv-entry.lock").open("w") as lock:
        try:
            acquire_entry_lock(lock, timeout)
            evaluation_cache = seed_evaluation_cache(root, env)
            # `devenv shell` deliberately ignores failed entry tasks in 2.3.1.
            # The public task command provides a strict exit status and exports.
            outputs = native("running devenv setup tasks", "tasks", "run", "devenv:enterShell", "--mode", "all")
            environment = native("evaluating devenv tools", "print-dev-env", "--json")
            retain_profile(root, cache, env)
            if evaluation_cache:
                snapshot_evaluation_cache(*evaluation_cache)
        except (ValueError, TimeoutError, subprocess.TimeoutExpired) as error:
            message = str(error)
            if isinstance(error, TimeoutError):
                message += "; retry with --setup-timeout SECONDS for a larger budget"
            message += "\nOpen the baseline repair shell without running project setup:\n" + repair_command(root, env)
            (cache / "error").write_text(message + "\n")
            raise ValueError(message) from error
        (cache / "error").unlink(missing_ok=True)
    lock_after = lock_file.read_bytes() if lock_file.is_file() else None
    if lock_after != lock_before:
        print("agent-exec: devenv.lock " + ("created" if lock_before is None else "updated")
              + " from devenv.yaml inputs; review and commit it", file=sys.stderr, flush=True)
    exports = {}
    for name in sorted(outputs):
        output = outputs[name]
        if not isinstance(output, dict) or not isinstance(output.get("devenv"), dict):
            continue
        metadata = output["devenv"]
        exports.update({name: value for name, value in metadata.get("env", {}).items()
                        if isinstance(value, str)})
        for message in metadata.get("messages", []):
            if isinstance(message, str):
                print(message, file=sys.stderr)
    return environment, exports


def retain_profile(root, cache, env):
    """Register a root at a path the host daemon can resolve outside the namespace."""
    shell = (root / ".devenv/gc/shell").resolve(strict=True)
    profile = cache / "devenv-profile"
    if profile.is_symlink() and profile.resolve() == shell:
        return
    subprocess.run(
        ["nix-store", "--realise", str(shell), "--add-root", str(profile), "--indirect"],
        env=env, check=True, stdout=subprocess.DEVNULL, timeout=30,
    )
