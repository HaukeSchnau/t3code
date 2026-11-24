import json
import os
from pathlib import Path
import socketserver
import tempfile
import threading
import unittest
from unittest.mock import patch

import agent_exec as runtime
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

if __name__ == "__main__":
    unittest.main()
