"""Thread worlds: every repo of a world through worldfs, with this thread's own checkouts.

The worldfs daemon (native/worldfs, README.md there) owns the views, checkouts and unpushed-work
rules. agent-exec owns the thread's holder namespace, registers it with the daemon, and builds
each launch from the daemon's binds.
"""

import contextlib
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import stat
import subprocess
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


def create(runtime, root, *, thread, world, path, layout, profile, project_id, repo=None, mounts=()):
    if not THREAD.fullmatch(thread):
        raise ValueError("The thread key must be letters, digits, dot, dash or underscore")
    if not Path(path).is_absolute():
        raise ValueError("The world's path must be absolute")
    root = Path(root).expanduser().resolve()
    locks = runtime.STATE / "provision-locks"
    locks.mkdir(parents=True, exist_ok=True)
    with (locks / runtime.identity(root)).open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if any(not Path(mount).is_absolute() for mount in mounts):
            raise ValueError("A world's mounts must be absolute paths")
        wanted = {"name": world, "path": str(path), "thread": thread, "repo": repo}
        existing = runtime.lookup(root)
        if existing and existing["root"] == str(root):
            if ({key: existing.get("world", {}).get(key) for key in wanted} != wanted
                    or (layout and existing["world"]["layout"] != layout)
                    or existing.get("projectId") != project_id
                    or existing["workspace"]["profile"] != profile):
                raise ValueError("This directory is registered with another world, thread or profile")
            if existing["world"].get("mounts", []) != list(mounts):
                # Mounts are bound at launch, so a changed setting reaches the next launch.
                existing["world"]["mounts"] = list(mounts)
                runtime.write_text(runtime.record_path(root), json.dumps(existing) + "\n")
            if repo and not (root / ".git").exists():
                # A setup interrupted between writing the record and installing the clone.
                clone_world_repo(repo, staging_path(runtime, root))
                install_clone(runtime, root)
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
        if repo:
            repo_layout = clone_world_repo(repo, staging_path(runtime, root))
            layout = layout or repo_layout
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
            "world": {**wanted, "layout": layout, "mounts": list(mounts)},
        }
        try:
            workspaces.prepare_private_state(runtime, record, profile, baseline)
            runtime.record_path(root).parent.mkdir(parents=True, exist_ok=True)
            runtime.write_text(runtime.record_path(root), json.dumps(record) + "\n")
        except BaseException:
            shutil.rmtree(staging_path(runtime, root), ignore_errors=True)
            raise
        # Written first, so a retry after an interruption finds the record and installs the clone.
        if repo:
            install_clone(runtime, root)
        # The record stays unregistered until the daemon accepts it; a retry registers again.
        register(runtime, record)
        return record


# A caller's repository, config and pathspec overrides (git rev-parse --local-env-vars, and the
# pathspec switches) would point these commands at another repository or change what they stage.
FOREIGN_GIT_VARIABLES = {
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_COMMON_DIR", "GIT_NAMESPACE",
    "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
}


def git_environment():
    """Background git: no prompts, and nothing a caller's environment points elsewhere."""
    environment = {key: value for key, value in os.environ.items()
                   if key not in FOREIGN_GIT_VARIABLES and not key.startswith("GIT_CONFIG_")}
    return {**environment, "GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": "ssh -o BatchMode=yes"}


def git(root, *args, check=True, stdin=None):
    result = subprocess.run(["git", "-C", str(root), *args], text=True, capture_output=True,
                            timeout=300, env=git_environment(), input=stdin)
    if check and result.returncode != 0:
        raise ValueError(f"git {args[0]} failed: {(result.stderr or result.stdout).strip()}")
    return result


def staging_path(runtime, root):
    """Where agent-exec clones a thread world's repo before it becomes the root; it owns this."""
    return runtime.STATE / "world-staging" / runtime.identity(root)


def clone_world_repo(repo, staging):
    """Clones and sets up the world repo in `staging`; returns its world.json layout."""
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        git(staging, "clone", "--quiet", repo, ".")
        # Hosts sign commits with a key only an interactive session holds.
        git(staging, "config", "commit.gpgsign", "false")
        git(staging, "config", "user.name", f"T3 on {os.uname().nodename}")
        git(staging, "config", "user.email", f"t3@{os.uname().nodename}")
        if git(staging, "rev-parse", "--verify", "--quiet", "@{upstream}", check=False).returncode:
            raise ValueError("the world repo has no commits yet; push a first commit to it")
        return parse_layout(json.dumps(world_config(staging).get("layout", [])))
    except Exception as error:
        shutil.rmtree(staging, ignore_errors=True)
        raise ValueError(f"Could not set up the world repo {repo}: {error}") from error


def install_clone(runtime, root):
    """Moves the set-up clone in as the root. rename() replaces the empty root in one step, so an
    interruption leaves either the empty root or the clone. Both are on the home's filesystem,
    as thread worlds are anyway (pnpm reflinks from agent-exec's state)."""
    staging_path(runtime, root).rename(root)


def world_config(root, ref=None):
    """The world repo's world.json, from the working tree or from `ref`."""
    if ref is None:
        path = Path(root) / "world.json"
        config = json.loads(path.read_text()) if path.exists() else {}
    else:
        # Only a world.json that isn't there means no policy; one git can't read stops here.
        present = git(root, "ls-tree", "--name-only", ref, "--", "world.json").stdout.strip()
        config = json.loads(git(root, "show", f"{ref}:world.json").stdout) if present else {}
    never = config.get("neverCommit", []) if isinstance(config, dict) else None
    if not isinstance(never, list) or not all(isinstance(glob, str) for glob in never):
        raise ValueError("world.json must be an object whose neverCommit is a list of globs")
    return config


# Never pushed, whatever world.json says.
SECRET = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----|AGE-SECRET-KEY-1|ENC\[AES256_GCM,")
MAX_NOTE_BYTES = 1024 * 1024


def listed(path, pattern):
    """world.json globs: `**/` matches any number of folders, and a bare name matches anywhere."""
    return PurePosixPath(path).full_match(pattern if "/" in pattern else "**/" + pattern)


def refusals(root, blobs, never):
    """Why each of `blobs` ([(id, path)]) must never leave this machine, by path."""
    if not blobs:
        return {}
    sizes = dict(line.split(" ", 1) for line in git(
        root, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        stdin="".join(f"{blob}\n" for blob in {blob for blob, _ in blobs})).stdout.splitlines())
    refused, secret = {}, {}
    for blob, path in blobs:
        kind, _, size = sizes.get(blob, "missing 0").partition(" ")
        if kind != "blob":
            continue
        if any(listed(path, pattern) for pattern in never):
            refused[path] = "listed in world.json neverCommit"
        elif int(size) > MAX_NOTE_BYTES:
            refused[path] = "larger than 1 MiB"
        else:
            if blob not in secret:
                content = subprocess.run(["git", "-C", str(root), "cat-file", "blob", blob],
                                         capture_output=True, timeout=60, check=True,
                                         env=git_environment()).stdout
                secret[blob] = bool(SECRET.search(content))
            if secret[blob]:
                refused[path] = "holds a private key or sops secret"
    return refused


# What the push destination already has; the world repo's only remote is origin.
PUBLISHED = ["--not", "--remotes=origin"]


def tree_entries(root, commit):
    for entry in git(root, "ls-tree", "-r", "-z", commit).stdout.split("\0"):
        meta, _, path = entry.partition("\t")
        if path:
            yield meta.split(" ")[2], path


def outgoing_refusals(root, tip, upstream, never):
    """Every file the push of `tip` would send or name: its content where origin lacks it, and its
    path wherever an outgoing commit puts it, even with content origin already has."""
    new = {line.split(" ", 1)[0] for line in
           git(root, "rev-list", "--objects", tip, *PUBLISHED).stdout.splitlines()}
    published = set(tree_entries(root, upstream))
    blobs, named = [], {}
    for commit in git(root, "rev-list", tip, *PUBLISHED).stdout.split():
        for blob, path in tree_entries(root, commit):
            if blob in new:
                blobs.append((blob, path))
            elif (blob, path) not in published and any(listed(path, glob) for glob in never):
                named[path] = "listed in world.json neverCommit"
    return {**named, **refusals(root, blobs, never)}


def notes_state(root):
    """Changed files, commits on HEAD, a local branch or a tag that no remote has, and stashes."""
    dirty = git(root, "status", "--porcelain").stdout.splitlines()
    ahead = int(git(root, "rev-list", "--count", "HEAD", "--branches", "--tags",
                    *PUBLISHED).stdout.strip())
    # A stash is this clone's own work whatever origin has, so any stash keeps the world.
    if git(root, "rev-parse", "--verify", "--quiet", "refs/stash", check=False).returncode == 0:
        ahead += max(1, len(git(root, "stash", "list").stdout.splitlines()))
    return {"dirty": len(dirty), "ahead": ahead}


def fetch_origin(root):
    """origin's branches as they are now. Only branch tracking refs are pruned, never a local tag:
    an explicit refspec, --refmap= and --no-tags keep configured refspecs, mappings and
    fetch.pruneTags out of it."""
    git(root, "fetch", "--quiet", "--prune", "--no-tags", "--refmap=", "origin",
        "+refs/heads/*:refs/remotes/origin/*")


def merge_clashes(root):
    """Untracked or ignored files in the way of merging the upstream: git's merge would replace
    them, ignored ones even with --no-overwrite-ignore. Only the paths the merge changes are looked
    at, git does the looking (it never follows a symlink), and nothing is written."""
    result = git(root, "merge-tree", "--write-tree", "HEAD", "@{upstream}", check=False)
    if result.returncode not in (0, 1):  # 1 is a conflicted merge, which merge itself refuses
        raise ValueError(f"git merge-tree failed: {result.stderr.strip()}")
    changed = [path for path in git(root, "diff", "--name-only", "-z", "--no-renames", "HEAD",
                                    result.stdout.split("\n", 1)[0]).stdout.split("\0") if path]
    tracked = set(git(root, "ls-files", "-z").stdout.split("\0"))
    clashes, probe = set(), []
    for path in changed:
        # Folders above it first: an untracked file or symlink where the merge needs a folder.
        blocked = False
        for parent in reversed(PurePosixPath(path).parents[:-1]):
            if (root / parent).is_symlink() or (root / parent).is_file():
                if str(parent) not in tracked:
                    clashes.add(str(parent))
                blocked = True
                break
        if not blocked:
            probe.append(path)
    if probe:
        # The path itself, or anything below a folder where the merge puts a file.
        specs = [f":(literal){path}" for path in probe]
        for extra in ([], ["--ignored", "--exclude-standard"]):
            clashes.update(path for path in git(root, "ls-files", "-z", "--others", *extra, "--",
                                                *specs).stdout.split("\0") if path)
    return sorted(clashes)


def notes_lock(runtime, root):
    locks = runtime.STATE / "provision-locks"
    locks.mkdir(parents=True, exist_ok=True)
    lock = (locks / ("notes-" + runtime.identity(root))).open("w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    return lock


def push_notes(runtime, record):
    """Commits the thread's note changes, merges the remote's (union for notes), and pushes.

    Files world.json's neverCommit lists, files over 1 MiB and private keys stay out of the
    commit, and any of them in an unpushed commit stops the push; the commits stay here and keep
    the thread world from being removed.
    """
    root = Path(record["root"])
    if not record.get("world", {}).get("repo"):
        raise ValueError("This thread world has no world repo")
    with notes_lock(runtime, root):
        # The policy and the published refs come from origin as it is now; --prune drops tracking
        # refs of branches origin deleted, which would otherwise hide history from the check.
        fetch_origin(root)
        # A pruned upstream stops here, before anything is staged under an empty policy.
        upstream = git(root, "rev-parse", "--verify", "@{upstream}").stdout.strip()
        git(root, "add", "--all")
        never = world_config(root, upstream).get("neverCommit", [])
        staged = git(root, "diff", "--cached", "--name-only", "-z", "--no-renames",
                     "--diff-filter=d").stdout
        paths = {path for path in staged.split("\0") if path}
        index = []
        for line in git(root, "ls-files", "--stage", "-z").stdout.split("\0"):
            meta, _, path = line.partition("\t")
            if path in paths:
                index.append((meta.split(" ")[1], path))
        held = refusals(root, index, never)
        if held:
            git(root, "reset", "--quiet", "--", *(f":(literal){path}" for path in held))
        committed = git(root, "diff", "--cached", "--quiet", check=False).returncode == 1
        if committed:
            git(root, "commit", "--quiet", "--no-verify", "-m", f"Notes from {record['world']['thread']}")
        branch = git(root, "rev-parse", "--abbrev-ref", "@{upstream}").stdout.strip().split("/", 1)[1]
        for attempt in range(3):
            if attempt:
                fetch_origin(root)
            if clash := merge_clashes(root):
                raise Refused("conflict", "The world repo now tracks files this world holds "
                              "untracked, so the notes were not merged: " + ", ".join(clash))
            merged = git(root, "merge", "--quiet", "--no-edit", "@{upstream}", check=False)
            if merged.returncode != 0:
                git(root, "merge", "--abort", check=False)
                raise Refused("conflict", "Notes could not merge with the world repo, so the local "
                              f"commits stay: {(merged.stdout + merged.stderr).strip()}")
            # Check one commit id and push exactly that id.
            tip = git(root, "rev-parse", "HEAD").stdout.strip()
            upstream = git(root, "rev-parse", "@{upstream}").stdout.strip()
            refused = outgoing_refusals(root, tip, upstream,
                                        world_config(root, upstream).get("neverCommit", []))
            if refused:
                raise Refused("refused", "These files must never leave this machine, so the notes "
                              "were not pushed: " + ", ".join(f"{path} ({why})" for path, why in sorted(refused.items()))
                              + ". Take them out of the unpushed commits (git reset @{upstream}, then "
                              "commit again without them).")
            # Only this ref: no submodules and no tags the check never saw.
            pushed = git(root, "push", "--quiet", "--no-recurse-submodules", "--no-follow-tags",
                         "origin", f"{tip}:refs/heads/{branch}", check=False)
            if pushed.returncode == 0:
                if held:
                    raise Refused("refused", "These files must never leave this machine, so they "
                                  "stay out of the world repo: " + ", ".join(
                                      f"{path} ({why})" for path, why in sorted(held.items())))
                return {"committed": committed, **notes_state(root)}
        raise Refused("failed", f"Notes could not be pushed: {pushed.stderr.strip()}")


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


def bind_arguments(binds, mounts=()):
    """The daemon's binds, in its order, then the world's read-only mounts. bwrap's binds are
    slaves of the host's mounts, so the views mount that a restarted daemon puts back under
    <state>/mnt reaches this namespace."""
    args = []
    for entry in binds:
        args += ["--ro-bind" if entry.get("readOnly") else "--bind", entry["source"], entry["target"]]
    for mount in mounts:
        # A store that isn't mounted on this host leaves the path missing, not the launch failed.
        args += ["--ro-bind-try", mount, mount]
    return args


def sync_and_exec(command):
    """Runs first in each new launch namespace, so a checkout that raced its binds reaches it."""
    try:
        call({"method": "sync"}, os.environ.pop("AGENT_EXEC_WORLD_SOCKET", None))
    except ValueError as error:
        print(f"agent-exec: this thread world could not sync with worldfs: {error}", file=sys.stderr)
        return 1
    os.execvp(command[0], command)


def loose_files(root, checkouts, views=frozenset(), tracked=frozenset(), repo=False):
    """Files outside the thread's checkouts: no remote has them, and the daemon doesn't look.

    In a repo the thread only viewed, `.git` is the daemon's: registering the thread's admin
    worktree (`git worktree add --no-checkout`) writes it, and teardown removes it. The world
    repo's own files (`tracked`, and its `.git`) are pushed before teardown.
    """
    if "." in checkouts:
        return []
    if repo:
        checkouts = {*checkouts, ".git"}
    loose = []

    def unreadable(error):
        loose.append(str(Path(error.filename).relative_to(root)))

    for directory, children, files in os.walk(root, onerror=unreadable):
        relative = Path(directory).relative_to(root)
        children[:] = [child for child in children if str(relative / child) not in checkouts]
        loose += [str(relative / name) for name in files
                  if not (name == ".git" and str(relative) in views
                          and stat.S_ISREG(os.lstat(Path(directory) / name).st_mode))
                  and os.path.normpath(relative / name) not in tracked]
        loose += [str(relative / child) for child in children if (Path(directory) / child).is_symlink()]
    return sorted(loose)


def teardown(runtime, record):
    """Removes the thread world only when nothing in it would be lost; otherwise keeps all of it.

    The private home stays, so a thread resumed in the same ROOT keeps its provider sessions.
    """
    if not record["world"].get("repo"):
        return remove_world(runtime, record)
    # A notes push from T3 runs outside the thread's processes, so retire's stop misses it.
    with notes_lock(runtime, record["root"]):
        return remove_world(runtime, record)


def remove_world(runtime, record):
    world, root = record["world"], Path(record["root"])
    checkouts, views = set(), set()
    if world.get("registered"):
        try:
            status = call({"method": "status", "thread": world["thread"]})
        except Refused as error:
            if error.code != "unknown-thread":
                raise
            status = {"repos": []}
        for repo in status.get("repos") or []:
            directory = os.path.relpath(repo["dir"], world["path"])
            if repo["state"] == "checked-out":
                checkouts.add(directory)
            elif repo["state"] == "view":
                views.add(directory)
    tracked, repo = frozenset(), world.get("repo") and (root / ".git").is_dir()
    if repo:
        # What origin has now, not when this clone last fetched: a branch origin deleted since
        # would otherwise count as pushed. An unreachable origin keeps the world.
        fetch_origin(root)
        state = notes_state(root)
        if state["dirty"] or state["ahead"]:
            raise Refused("work", f"{world['path']} holds notes the world repo doesn't have yet: "
                          f"{state['dirty']} changed files, {state['ahead']} unpushed commits")
        tracked = frozenset(git(root, "ls-files", "-z").stdout.split("\0")) - {""}
    loose = loose_files(root, checkouts, views, tracked, repo) if root.exists() else []
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
    # Clean and pushed, checked above with the thread's processes already stopped.
    for name in tracked:
        with contextlib.suppress(FileNotFoundError):
            (root / name).unlink()
    if repo:
        shutil.rmtree(root / ".git")
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
