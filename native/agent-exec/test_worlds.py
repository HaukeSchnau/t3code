import json
import os
from pathlib import Path
import socketserver
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import agent_exec as runtime
import project_files
import workspaces
import worlds

BINDS = [
    {"source": "ROOT", "target": "/home/agent/World"},
    {"source": "/state/mnt", "target": "/state/mnt"},
    {"source": "/state/mnt/views/.admin/t3-a", "target": "/run/worldfs/admin", "readOnly": True},
    {"source": "/state/mnt/views/w/example.com/x/a@1", "target": "/home/agent/World/example.com/x/a"},
]


class FakeDaemon:
    """The worldfs control socket: one JSON line in, one out."""

    def __init__(self, path):
        self.requests, self.refusals, self.results = [], {}, {}
        daemon = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                request = json.loads(self.rfile.readline())
                daemon.requests.append(request)
                refusal = daemon.refusals.get(request["method"])
                if refusal:
                    response = {"ok": False, "error": {"code": refusal[0], "message": refusal[1]}}
                else:
                    response = {"ok": True, "binds": BINDS, "socket": str(path),
                                **daemon.results.get(request["method"], {})}
                self.wfile.write(json.dumps(response).encode() + b"\n")

        self.server = socketserver.ThreadingUnixStreamServer(str(path), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def methods(self):
        return [request["method"] for request in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@t",
                           "-c", "commit.gpgsign=false", *args],
                          check=True, text=True, capture_output=True, env=worlds.git_environment()).stdout


class ThreadWorldTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.daemon = FakeDaemon(self.base / "ctl.sock")
        self.addCleanup(self.daemon.close)
        for context in [
            patch.object(runtime, "STATE", self.base / "state"),
            patch.object(runtime, "PUBLISH_ROOT", self.base / "published"),
            patch.object(runtime, "ensure_bridge"),
            patch.object(workspaces, "pin_profile"),
            patch.object(workspaces, "ensure_network", return_value=[]),
            patch.object(workspaces, "ensure_process_namespace",
                         return_value={"pid": os.getpid(), "runtime": "/tmp/runtime/x"}),
            patch.object(workspaces, "provider_config"),
            patch.dict(os.environ, {
                "AGENT_EXEC_BASE_PROFILE": str(self.base),
                "AGENT_EXEC_REAL_BASH": "/bin/bash",
                "AGENT_EXEC_DEVENV": "/bin/true",
                "WORLDFS_SOCKET": str(self.base / "ctl.sock"),
                "HOME": str(self.home),
            }),
        ]:
            context.start()
            self.addCleanup(context.stop)

    def create(self, root="thread", **overrides):
        options = {"thread": "t3-a", "world": "w", "path": str(self.home / "World"),
                   "layout": [{"prefix": "other.org/", "dir": "Other/"}], "profile": "familiar",
                   "project_id": "project:one", **overrides}
        return worlds.create(runtime, self.base / root, **options)

    def test_create_registers_the_holder_and_repeats_only_with_the_same_arguments(self):
        record = self.create()
        self.assertEqual(record["workspace"]["visibleRoot"], str(self.home / "World"))
        self.assertEqual(record["world"]["thread"], "t3-a")
        register = self.daemon.requests[0]
        self.assertEqual((register["method"], register["pid"], register["root"]),
                         ("register", os.getpid(), record["root"]))
        self.assertEqual(self.create(), record)
        with self.assertRaisesRegex(ValueError, "another world"):
            self.create(thread="t3-b")
        # A key the daemon holds for another root stays unregistered here, so retiring this root
        # can't tear down the other root's thread.
        self.daemon.refusals["register"] = ("invalid", "thread t3-a is already registered with another world, root, path or layout")
        with self.assertRaisesRegex(ValueError, "already registered"):
            self.create("second")
        second = runtime.lookup(self.base / "second")
        self.assertFalse(second["world"].get("registered"))
        worlds.teardown(runtime, second)
        self.assertNotIn("teardown", self.daemon.methods())
        self.assertIsNone(runtime.lookup(self.base / "second"))
        del self.daemon.refusals["register"]
        # A thread that never touched a repo has no repos in its status.
        self.daemon.results["status"] = {"repos": None}
        fresh = self.create("fresh", thread="t3-fresh")
        worlds.teardown(runtime, fresh)
        self.assertFalse((self.base / "fresh").exists())
        del self.daemon.results["status"]
        (self.base / "busy").mkdir()
        (self.base / "busy/file").write_text("x")
        with self.assertRaisesRegex(ValueError, "new or empty"):
            self.create("busy")

    def test_launch_applies_the_daemons_binds_and_syncs_before_the_command(self):
        record = self.create()
        launched = {}

        def run_scope(args, unit, fds):
            launched["args"] = args
            launched["environment"] = os.read(int(args[args.index("--args") + 1]), 1 << 20).decode().split("\0")
            return 0

        (self.home / ".config/git").mkdir(parents=True)
        record["world"]["mounts"] = ["/mnt/store"]
        record["world"]["repo"] = "git@example.com:w.git"
        with patch.object(workspaces, "run_scope", side_effect=run_scope):
            runtime.launch(record, record["root"], ["claude"])
        args = launched["args"]
        start = args.index(BINDS[1]["source"]) - 4
        self.assertEqual(args[start:start + 12], [
            "--bind", "ROOT", "/home/agent/World",
            "--bind", "/state/mnt", "/state/mnt",
            "--ro-bind", "/state/mnt/views/.admin/t3-a", "/run/worldfs/admin",
            "--bind", "/state/mnt/views/w/example.com/x/a@1", "/home/agent/World/example.com/x/a",
        ])
        git_config = args.index(str(self.home / ".config/git"))
        self.assertEqual(args[git_config - 1], "--ro-bind")
        self.assertEqual(args[start + 12:start + 18], [
            "--ro-bind-try", "/mnt/store", "/mnt/store",
            # T3's git on the host must not run hooks or filters the thread wrote.
            "--ro-bind", record["root"] + "/.git", str(self.home / "World/.git"),
        ])
        # The private home goes first, so the world's binds land on top of it.
        self.assertLess(args.index(str(self.home)), start)
        self.assertNotIn(record["root"], args[:start])
        separator = args.index("--", args.index("--chdir"))
        self.assertEqual(args[separator + 1:separator + 4], [runtime.LAUNCHER, "world-sync", "--"])
        self.assertEqual(args[args.index("--chdir") + 1], str(self.home / "World"))
        socket_variable = launched["environment"].index("AGENT_EXEC_WORLD_SOCKET")
        self.assertEqual(launched["environment"][socket_variable + 1], str(self.base / "ctl.sock"))

    def test_sync_runs_before_the_command_and_a_failed_sync_stops_it(self):
        with patch.object(os, "execvp") as execute:
            worlds.sync_and_exec(["true"])
        self.assertEqual(self.daemon.methods()[-1], "sync")
        execute.assert_called_once_with("true", ["true"])
        self.daemon.refusals["sync"] = ("failed", "ns-mount in pid 7: gone")
        with patch.object(os, "execvp") as execute:
            self.assertEqual(worlds.sync_and_exec(["true"]), 1)
        execute.assert_not_called()

    def test_teardown_keeps_the_world_while_anything_in_it_would_be_lost(self):
        record = self.create()
        root = Path(record["root"])
        state = runtime.project_state(record)
        self.daemon.results["status"] = {"repos": [
            {"repo": "example.com/x/a", "dir": str(self.home / "World/example.com/x/a"), "state": "checked-out"},
            {"repo": "example.com/x/b", "dir": str(self.home / "World/example.com/x/b"), "state": "view"},
            {"repo": "example.com/x/d", "dir": str(self.home / "World/example.com/x/d"), "state": "view"},
        ]}
        for directory in ["example.com/x/a", "example.com/x/b", "Other/c", "empty/nested", "locked"]:
            (root / directory).mkdir(parents=True)
        (root / "example.com/x/a/README.md").write_text("checked out")
        (root / "notes.md").write_text("written at the top of the world")
        (root / "example.com/x/b/stray").write_text("under a repo the thread never checked out")
        # The daemon's admin worktree registration writes this into a viewed repo's directory.
        (root / "example.com/x/b/.git").write_text("gitdir: /cache/w/mirrors/example.com/x/b.git/worktrees/b1\n")
        (root / "Other/c/.git").write_text("gitdir: not the daemon's, c was never touched\n")
        (root / "example.com/x/d").mkdir()
        (root / "example.com/x/d/.git").symlink_to(root / "notes.md")
        (root / "locked/file").write_text("x")
        (root / "locked").chmod(0)
        self.addCleanup(os.system, f"chmod -R u+rwx {root} 2>/dev/null")
        with self.assertRaisesRegex(worlds.Refused, "outside its checkouts: Other/c/.git, example.com/x/b/stray, example.com/x/d/.git, locked, notes.md$"):
            worlds.teardown(runtime, record)
        self.assertNotIn("teardown", self.daemon.methods())

        (root / "locked").chmod(0o700)
        for name in ["notes.md", "example.com/x/b/stray", "locked/file", "Other/c/.git", "example.com/x/b/.git", "example.com/x/d/.git"]:
            (root / name).unlink()
        self.daemon.refusals["teardown"] = ("work", "thread t3-a holds work no remote has: example.com/x/a")
        with self.assertRaisesRegex(worlds.Refused, "holds work no remote has"):
            worlds.teardown(runtime, record)
        self.assertTrue((root / "example.com/x/a/README.md").exists())
        self.assertTrue(runtime.lookup(root)["world"]["registered"])
        # A record that can't be marked unconfirmed never reaches the daemon's teardown.
        with patch.object(runtime, "write_text", side_effect=OSError("disk full")), \
                self.assertRaises(OSError):
            worlds.teardown(runtime, runtime.lookup(root))
        self.assertEqual(self.daemon.methods().count("teardown"), 1)

        # A failure after the daemon may have released the key leaves the record unconfirmed.
        self.daemon.refusals["teardown"] = ("failed", "saving state: disk full")
        with self.assertRaisesRegex(worlds.Refused, "disk full"):
            worlds.teardown(runtime, record)
        self.assertFalse(runtime.lookup(root)["world"]["registered"])
        worlds.set_registered(runtime, record, True)  # as the next launch's register would

        # Files the daemon left behind keep the registration, and nothing is deleted.
        del self.daemon.refusals["teardown"]
        with self.assertRaisesRegex(worlds.Refused, "still holds files"):
            worlds.teardown(runtime, record)
        self.assertTrue((root / "example.com/x/a/README.md").exists())
        # The daemon freed the key, so a retry must not tear down whoever takes it next.
        self.assertFalse(runtime.lookup(root)["world"]["registered"])

        (root / "example.com/x/a/README.md").unlink()
        worlds.teardown(runtime, runtime.lookup(root))
        self.assertEqual(self.daemon.methods().count("teardown"), 3)
        self.assertFalse(root.exists())
        self.assertFalse(runtime.record_path(root).exists())
        # A thread resumed in the same root keeps its provider sessions.
        self.assertTrue(state.exists())

    def test_forgetting_state_removes_it_only_where_nothing_is_registered(self):
        torn_down = self.create()
        worlds.teardown(runtime, torn_down)
        live = self.create("live", thread="t3-live")
        identity = runtime.identity(torn_down["root"])
        stopped = []
        with patch.object(runtime, "stop_unit", side_effect=stopped.append):
            forget = lambda record: project_files.forget_private_state(runtime, record["root"])
            self.assertEqual(forget(torn_down), "removed")
            self.assertEqual(stopped, [f"agent-exec-{identity}", f"agent-env-{identity}.slice"])
            # What a removal that failed after its rename leaves; asking again finishes it, and
            # leaves other roots' removals to theirs.
            (runtime.STATE / "environments" / f".removed-{identity}-failed/home").mkdir(parents=True)
            (runtime.STATE / "environments" / ".removed-other-failed").mkdir()
            self.assertEqual([forget(torn_down), forget(torn_down), forget(live)],
                             ["removed", "absent", "registered"])
        self.assertEqual(sorted(path.name for path in (runtime.STATE / "environments").iterdir()),
                         [".removed-other-failed", runtime.identity(live["root"])])

    def world_repo(self):
        """A remote world repo, and a second clone that stands for another thread."""
        seed = self.base / "seed"
        (seed / "agent-notes").mkdir(parents=True)
        (seed / "world.json").write_text(json.dumps({
            "layout": [{"prefix": "example.com/", "dir": "Repos/"}],
            "neverCommit": ["**/evidence/**"],
        }))
        (seed / ".gitignore").write_text("/*\n!/.gitignore\n!/.gitattributes\n!/world.json\n!/agent-notes/\n")
        (seed / ".gitattributes").write_text("agent-notes/** merge=union\n")
        (seed / "agent-notes/shared.md").write_text("first\n")
        git(seed, "init", "-q", "-b", "main")
        git(seed, "add", "-A")
        git(seed, "commit", "-qm", "seed")
        remote = self.base / "remote.git"
        subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(remote)], check=True)
        other = self.base / "other"
        subprocess.run(["git", "clone", "-q", str(remote), str(other)], check=True)
        return remote, other

    def test_a_world_repo_is_the_root_and_its_notes_reach_the_remote_merged(self):
        remote, other = self.world_repo()
        record = self.create(repo=str(remote), layout=[])
        root = Path(record["root"])
        self.assertEqual(record["world"]["layout"], [{"prefix": "example.com/", "dir": "Repos/"}])
        self.assertEqual(self.daemon.requests[0]["layout"], record["world"]["layout"])
        self.assertEqual(self.create(repo=str(remote), layout=[]), record)
        # A layout given on the command line still gets the world repo.
        given = self.create("given", thread="t3-given", repo=str(remote))
        self.assertTrue((Path(given["root"]) / "agent-notes/shared.md").exists())
        # A world repo the root can't take leaves the root empty for a retry.
        with self.assertRaisesRegex(ValueError, "Could not set up the world repo"):
            self.create("broken", thread="t3-broken", repo=str(self.base / "missing.git"))
        self.assertEqual(list((self.base / "broken").iterdir()), [])
        empty_remote = self.base / "empty.git"
        subprocess.run(["git", "init", "-q", "--bare", str(empty_remote)], check=True)
        with self.assertRaisesRegex(ValueError, "no commits yet"):
            self.create("empty", thread="t3-empty", repo=str(empty_remote), layout=[])
        odd = self.base / "odd"
        git(odd.parent, "clone", "-q", str(remote), str(odd))
        (odd / "world.json").write_text("[]")
        git(odd, "commit", "-qam", "odd")
        odd_remote = self.base / "odd.git"
        subprocess.run(["git", "clone", "-q", "--bare", str(odd), str(odd_remote)], check=True)
        with self.assertRaisesRegex(ValueError, "world.json must be an object"):
            self.create("shaped", thread="t3-shaped", repo=str(odd_remote), layout=[])
        self.assertEqual(list((self.base / "shaped").iterdir()), [])

        # Interrupted after the record but before the clone moved in: a retry finishes it.
        with patch.object(Path, "rename", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.create("interrupted", thread="t3-int", repo=str(remote), layout=[])
        self.assertEqual(list((self.base / "interrupted").iterdir()), [])
        self.create("interrupted", thread="t3-int", repo=str(remote), layout=[])
        self.assertTrue((self.base / "interrupted/agent-notes/shared.md").exists())
        # A neighbor of the root is never the clone's staging area.
        neighbor = self.base / ".neighbor.world-repo"
        neighbor.write_text("someone else's")
        self.create("neighbor", thread="t3-neighbor", repo=str(remote), layout=[])
        self.assertEqual(neighbor.read_text(), "someone else's")

        # Two threads append to the same note; the union driver keeps both lines.
        (root / "agent-notes/shared.md").write_text("first\nfrom this thread\n")
        (root / "Repos").mkdir()  # a repo's mount point stays out of git
        (other / "agent-notes/shared.md").write_text("first\nfrom another thread\n")
        git(other, "commit", "-qam", "other")
        git(other, "push", "-q")
        self.assertEqual(worlds.push_notes(runtime, record),
                         {"committed": True, "dirty": 0, "ahead": 0})
        shown = git(remote, "show", "main:agent-notes/shared.md")
        self.assertEqual(sorted(shown.splitlines()), ["first", "from another thread", "from this thread"])

        # Material world.json names, and private keys, never leave the machine.
        (root / "agent-notes/evidence").mkdir()
        (root / "agent-notes/evidence/capture.log").write_text("customer data")
        (root / "agent-notes/key.md").write_text("-----BEGIN PGP PRIVATE KEY BLOCK-----\n")
        (root / "agent-notes/public.md").write_text("-----BEGIN PGP PUBLIC KEY BLOCK-----\n")
        (root / "agent-notes/fine.md").write_text("a note\n")
        with patch.dict(os.environ, {"GIT_LITERAL_PATHSPECS": "1"}), \
                self.assertRaisesRegex(worlds.Refused, "agent-notes/evidence/capture.log .*agent-notes/key.md"):
            worlds.push_notes(runtime, record)
        self.assertEqual(git(remote, "ls-tree", "-r", "--name-only", "main", "agent-notes").split(),
                         ["agent-notes/fine.md", "agent-notes/public.md", "agent-notes/shared.md"])
        self.assertEqual(worlds.notes_state(root), {"dirty": 2, "ahead": 0})

        # A file is checked at every path it has, not only the first one git names.
        git(root, "reset", "-q")
        (root / "agent-notes/copy.md").write_text("customer data")
        git(root, "add", "-f", "agent-notes/copy.md", "agent-notes/evidence/capture.log")
        git(root, "commit", "-qm", "same content twice")
        with self.assertRaisesRegex(worlds.Refused, "were not pushed: agent-notes/evidence/capture.log"):
            worlds.push_notes(runtime, record)
        git(root, "reset", "-q", "--hard", "@{upstream}")

        # Content origin already has is still refused at a path world.json names.
        (root / "agent-notes/evidence").mkdir(exist_ok=True)
        (root / "agent-notes/evidence/published.md").write_text((root / "agent-notes/fine.md").read_text())
        git(root, "add", "-f", "agent-notes/evidence/published.md")
        git(root, "commit", "-qm", "published content, refused path")
        with self.assertRaisesRegex(worlds.Refused, "were not pushed: agent-notes/evidence/published.md"):
            worlds.push_notes(runtime, record)
        git(root, "reset", "-q", "--hard", "@{upstream}")

        # A commit made in the thread itself is checked before it leaves, too.
        (root / "agent-notes/evidence").mkdir(exist_ok=True)
        (root / "agent-notes/evidence/capture.log").write_text("customer data")
        (root / "agent-notes/key.md").write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "by the agent")
        before = git(remote, "rev-parse", "main")
        with self.assertRaisesRegex(worlds.Refused, "were not pushed: agent-notes/evidence/capture.log"):
            worlds.push_notes(runtime, record)
        self.assertEqual(git(remote, "rev-parse", "main"), before)
        self.assertEqual(worlds.notes_state(root)["ahead"], 1)
        git(root, "reset", "-q", "--hard", "@{upstream}")
        git(root, "clean", "-qfd", "agent-notes")

        # What a merge makes is checked too: two notes under 1 MiB union into one over it.
        (other / "agent-notes/big.md").write_text("".join(f"other {n}\n" for n in range(70000)))
        git(other, "pull", "-q", "--no-rebase")
        git(other, "add", "-A")
        git(other, "commit", "-qm", "other big")
        git(other, "push", "-q")
        (root / "agent-notes/big.md").write_text("".join(f"this {n}\n" for n in range(70000)))
        with self.assertRaisesRegex(worlds.Refused, "were not pushed: agent-notes/big.md \\(larger than 1 MiB\\)"):
            worlds.push_notes(runtime, record)

    def test_a_deleted_upstream_branch_stops_the_push_before_anything_is_staged(self):
        remote, _ = self.world_repo()
        record = self.create(repo=str(remote), layout=[])
        root = Path(record["root"])
        git(remote, "branch", "-q", "-m", "main", "renamed")
        (root / "agent-notes/evidence").mkdir()
        (root / "agent-notes/evidence/capture.log").write_text("customer data")
        with self.assertRaisesRegex(ValueError, "rev-parse failed"):
            worlds.push_notes(runtime, record)
        self.assertEqual(git(root, "ls-files", "agent-notes/evidence"), "")

    def test_a_file_the_remote_starts_tracking_never_overwrites_an_ignored_local_one(self):
        remote, other = self.world_repo()
        record = self.create(repo=str(remote), layout=[])
        root = Path(record["root"])
        (root / "scratch.md").write_text("only here\n")
        (other / ".gitignore").write_text((other / ".gitignore").read_text() + "!/scratch.md\n")
        (other / "scratch.md").write_text("from another thread\n")
        git(other, "add", "-A")
        git(other, "commit", "-qm", "track scratch.md")
        git(other, "push", "-q")
        with self.assertRaisesRegex(worlds.Refused, "tracks files this world holds untracked, .*: scratch.md"):
            worlds.push_notes(runtime, record)
        self.assertEqual((root / "scratch.md").read_text(), "only here\n")

        # A rename into the ignored path, and a file where an ignored folder holds work.
        (root / "scratch.md").unlink()
        worlds.push_notes(runtime, record)
        git(other, "pull", "-q", "--no-rebase")
        (root / "agent-notes/kept").mkdir()
        (root / "agent-notes/kept/work.txt").write_text("ignored work\n")
        git(root, "config", "core.excludesFile", str(self.base / "excludes"))
        (self.base / "excludes").write_text("agent-notes/kept/\n")
        git(other, "mv", "scratch.md", "renamed.md")
        (other / ".gitignore").write_text((other / ".gitignore").read_text() + "!/renamed.md\n")
        (other / "agent-notes/kept").write_text("now a file\n")
        git(other, "add", "-A")
        git(other, "commit", "-qm", "rename and replace")
        git(other, "push", "-q")
        (root / "renamed.md").write_text("ignored here\n")
        (root / "agent-notes/kept/link").symlink_to(self.base)
        with self.assertRaisesRegex(worlds.Refused, "agent-notes/kept/link, agent-notes/kept/work.txt, renamed.md"):
            worlds.push_notes(runtime, record)
        self.assertEqual((root / "agent-notes/kept/work.txt").read_text(), "ignored work\n")

    def test_world_json_globs_match_at_any_depth(self):
        for path, pattern, matched in [
            ("evidence/x.log", "**/evidence/**", True),
            ("agent-notes/evidence/a/b.log", "**/evidence/**", True),
            ("agent-notes/disk.qcow2", "*.qcow2", True),
            ("agent-notes/evidence.md", "**/evidence/**", False),
        ]:
            self.assertEqual(worlds.listed(path, pattern), matched, (path, pattern))
        (self.base / "world.json").write_text('{"neverCommit": [1]}')
        with self.assertRaisesRegex(ValueError, "list of globs"):
            worlds.world_config(self.base)

    def test_teardown_removes_a_pushed_world_repo_and_keeps_unpushed_notes(self):
        remote, _ = self.world_repo()
        record = self.create(repo=str(remote), layout=[])
        root = Path(record["root"])
        self.daemon.results["status"] = {"repos": []}
        (root / "agent-notes/new.md").write_text("not pushed yet\n")
        with self.assertRaisesRegex(worlds.Refused, "1 changed files, 0 unpushed commits"):
            worlds.teardown(runtime, record)
        worlds.push_notes(runtime, record)
        # A commit on another local branch is work no remote has, too.
        git(root, "switch", "-qc", "side")
        (root / "agent-notes/side.md").write_text("on a side branch\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "side")
        git(root, "switch", "-q", "main")
        with self.assertRaisesRegex(worlds.Refused, "0 changed files, 1 unpushed commits"):
            worlds.teardown(runtime, record)
        # A branch origin had once and deleted since is unpushed again.
        git(root, "push", "-q", "origin", "side")
        git(remote, "branch", "-qD", "side")
        with self.assertRaisesRegex(worlds.Refused, "0 changed files, 1 unpushed commits"):
            worlds.teardown(runtime, record)
        # A commit only a tag keeps survives the teardown's fetch, even with fetch.pruneTags on.
        git(root, "config", "fetch.pruneTags", "true")
        git(root, "config", "--add", "remote.origin.fetch", "refs/tags/*:refs/tags/*")
        git(root, "config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/tags/kept")
        git(root, "tag", "kept", "side")
        kept = git(root, "rev-parse", "kept")
        git(root, "branch", "-qD", "side")
        with self.assertRaisesRegex(worlds.Refused, "0 changed files, 1 unpushed commits"):
            worlds.teardown(runtime, record)
        self.assertEqual(git(root, "rev-parse", "kept"), kept)
        git(root, "tag", "-d", "kept")
        (root / "agent-notes/stashed.md").write_text("only in a stash\n")
        git(root, "stash", "-qu")
        with self.assertRaisesRegex(worlds.Refused, "0 changed files, [1-9] unpushed commits"):
            worlds.teardown(runtime, record)
        git(root, "stash", "drop", "-q")
        (root / "scratch.txt").write_text("ignored by the world repo, so on no remote")
        with self.assertRaisesRegex(worlds.Refused, "outside its checkouts: scratch.txt$"):
            worlds.teardown(runtime, record)
        (root / "scratch.txt").unlink()
        worlds.teardown(runtime, runtime.lookup(root))
        self.assertFalse(root.exists())
        self.assertIn("not pushed yet", git(remote, "show", "main:agent-notes/new.md"))


if __name__ == "__main__":
    unittest.main()
