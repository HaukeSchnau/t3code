"""Identity for sharing evaluated tools across checkouts without sharing runtime state."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def colocated_jj_repository(root):
    """The jj repository containing root, when its Git index is what Nix reads."""
    repository = next((directory for directory in (root, *root.parents) if (directory / ".jj").is_dir()), None)
    return repository if repository and (repository / ".git").exists() else None


def snapshot_untracked_files(root, cache, base_path):
    """Let Nix see new files in a colocated jj repository.

    Nix evaluates only files in the Git index, and jj adds new files to that
    index only when it snapshots the working copy. Files jj declines to track,
    such as oversized ones, are remembered so they do not trigger a snapshot on
    every command.
    """
    repository = colocated_jj_repository(root)
    if repository is None:
        return
    settings = {"capture_output": True, "timeout": 60, "env": {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "PATH": base_path}}

    def untracked():
        listing = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--others", "--exclude-standard", "-z"], check=True, **settings,
        ).stdout
        return hashlib.sha256(listing).hexdigest() if listing else None

    declined = cache / "untracked-after-snapshot"
    try:
        before = untracked()
        if before is None or (declined.exists() and declined.read_text() == before):
            return
        subprocess.run(["jj", "-R", str(repository), "util", "snapshot"], check=True, **settings)
        after = untracked()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        # Evaluation then reports the untracked file, with a jj hint.
        return
    if after is None:
        declined.unlink(missing_ok=True)
    else:
        declined.write_text(after)


def tracked_fingerprint(root, base_path):
    """Hash Nix's tracked source view, including unstaged edits and non-Nix inputs."""
    def git(*args):
        return subprocess.run(
            ["git", "-C", str(root), *args], capture_output=True, check=True,
            timeout=30, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "PATH": base_path},
        ).stdout

    try:
        git_root = Path(os.fsdecode(git("rev-parse", "--show-toplevel").strip()))
        if git_root != root:
            return None
        tracked = git("ls-files", "--stage", "-z")
        head = git("rev-parse", "HEAD")
        modified = git("diff-files", "--name-only", "-z")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    digest = hashlib.sha256(b"tracked-tools-v1\0")
    for value in (str(root), base_path, os.uname().machine):
        digest.update(value.encode() + b"\0")
    digest.update(tracked)
    digest.update(b"\0head\0" + head)
    for name in sorted(filter(None, modified.split(b"\0"))):
        path = root / os.fsdecode(name)
        digest.update(b"\0modified\0" + name + b"\0")
        if path.is_symlink():
            digest.update(b"link\0" + os.fsencode(os.readlink(path)))
        elif path.is_file():
            digest.update(b"executable" if path.stat().st_mode & 0o111 else b"regular")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
        elif not path.exists():
            digest.update(b"deleted")
        else:
            # Gitlinks need different Nix fetching options; don't share a result
            # when their working tree has changed outside the recorded gitlink.
            return None
    lock = root / "flake.lock"
    if lock.exists():
        contents = lock.read_bytes()
        # A relative path input may change outside this repository's source view.
        # TODO: Track relative input dependency trees so these evaluations can be shared too.
        try:
            if any(input.get("type") == "path"
                   for node in json.loads(contents).get("nodes", {}).values()
                   for input in (node.get("original", {}), node.get("locked", {}))):
                return None
        except (ValueError, AttributeError):
            return None
        digest.update(b"\0lock\0" + contents)
    return digest.hexdigest()


def prune_generations(project_cache, keep=3, max_age=14 * 24 * 3600, now=None):
    """Delete a project's old tool generations and the GC roots they hold.

    Each tracked-file fingerprint gets a generation with its own Nix profile,
    so every commit roots another closure. A generation survives while it is
    among the newest `keep` or was written within `max_age` seconds, which
    leaves time for workspaces still on an older commit to move on.
    """
    now = time.time() if now is None else now
    generations = sorted(
        (path for path in Path(project_cache).iterdir() if (path / "environment.json").exists()),
        key=lambda path: (path / "environment.json").stat().st_mtime,
        reverse=True,
    )
    for generation in generations[keep:]:
        if now - (generation / "environment.json").stat().st_mtime > max_age:
            shutil.rmtree(generation, ignore_errors=True)
