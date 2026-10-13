import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import devenv_environment
import project_files
import workspaces


class DevenvEnvironmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_evaluation_snapshot_keeps_committed_wal_data_and_independent_writes(self):
        source = self.root / "source.sqlite"
        destination = self.root / "other/cache.sqlite"
        with contextlib.closing(sqlite3.connect(source)) as db:
            db.execute("pragma journal_mode=wal")
            db.execute("create table observations (value text)")
            db.execute("insert into observations values ('committed')")
            db.commit()
            db.execute("insert into observations values ('uncommitted')")
            devenv_environment.snapshot_evaluation_cache(source, destination)
            with contextlib.closing(sqlite3.connect(destination)) as copied, copied:
                self.assertEqual(copied.execute("select value from observations").fetchall(), [("committed",)])
                copied.execute("delete from observations")
            self.assertEqual(db.execute("select count(*) from observations").fetchone()[0], 2)

    def test_seed_never_overwrites_existing_workspace_cache(self):
        database = self.root / ".devenv/nix-eval-cache.db"
        database.parent.mkdir()
        database.write_bytes(b"private workspace state")
        with patch.object(devenv_environment, "snapshot_evaluation_cache") as snapshot:
            self.assertIsNone(devenv_environment.seed_evaluation_cache(self.root, {
                "AGENT_EXEC_SHARED_DEVENV_CACHE": str(self.root / "shared"),
            }))
        snapshot.assert_not_called()
        self.assertEqual(database.read_bytes(), b"private workspace state")

    def test_invalid_snapshot_falls_back_without_creating_a_local_database(self):
        source = self.root / "bad.sqlite"
        source.write_bytes(b"not a database")
        destination = self.root / "cache/local.sqlite"
        with contextlib.redirect_stderr(io.StringIO()):
            devenv_environment.snapshot_evaluation_cache(source, destination)
        self.assertFalse(destination.exists())
        self.assertEqual(list(destination.parent.iterdir()), [])

    def test_nearest_definition_and_explicit_repair_selection(self):
        nested = self.root / "packages/app"
        nested.mkdir(parents=True)
        (self.root / "devenv.nix").touch()
        (nested / "flake.nix").touch()
        select = devenv_environment.definition
        self.assertEqual(select(self.root, nested), (nested, "flake"))
        (nested / "devenv.nix").touch()
        self.assertEqual(select(self.root, nested), (nested, "devenv"))
        self.assertEqual(select(self.root, nested, "flake"), (nested, "flake"))
        self.assertEqual(select(self.root, nested, "baseline"), (self.root, "baseline"))
        (nested / "flake.nix").unlink()
        with self.assertRaisesRegex(ValueError, "No flake environment"):
            select(self.root, nested, "flake")

    def test_native_setup_failure_cannot_read_or_execute_an_environment(self):
        (self.root / "devenv.lock").write_text("{}")
        with patch.dict(os.environ, {"AGENT_EXEC_DEVENV": "/pinned/devenv", "AGENT_EXEC_BWRAP": "/pinned/bwrap"}), patch.object(devenv_environment, "run_native") as native:
            native.return_value = subprocess.CompletedProcess([], 1, "")
            with self.assertRaisesRegex(ValueError, "failed with status 1"):
                devenv_environment.evaluate(self.root, self.root / "cache", {})
        self.assertEqual(native.call_count, 1)
        self.assertIn("devenv:enterShell", native.call_args.args[0])
        self.assertIn(devenv_environment.repair_command(self.root, {}), (self.root / "cache/error").read_text())

    def test_native_evaluation_follows_setup_and_allows_native_lock_creation(self):
        lock = self.root / "devenv.lock"
        shell = self.root / ".devenv/gc/shell"
        shell.parent.mkdir(parents=True)
        shell.touch()
        profile = self.root / "cache/devenv-profile"
        profile.parent.mkdir()
        profile.symlink_to(shell)
        outputs = {"z:last": {"devenv": {"env": {"RESULT": "last"}}},
                   "a:first": {"devenv": {"env": {"RESULT": "first"}}}}
        (self.root / "cache/error").write_text("previous setup failed")
        def run(command, *_):
            lock.write_text('{"native": true}')
            return subprocess.CompletedProcess(command, 0, json.dumps(outputs if "tasks" in command else {"variables": {}}))
        with patch.dict(os.environ, {"AGENT_EXEC_DEVENV": "/pinned/devenv", "AGENT_EXEC_BWRAP": "/pinned/bwrap"}), patch.object(devenv_environment, "run_native", side_effect=run) as native, contextlib.redirect_stderr(io.StringIO()) as diagnostic:
            environment, exports = devenv_environment.evaluate(self.root, self.root / "cache", {"AGENT_EXEC_SETUP_TIMEOUT": "1200"})
        self.assertIn("devenv.lock created from devenv.yaml inputs; review and commit it", diagnostic.getvalue())
        self.assertEqual(exports, {"RESULT": "last"})
        self.assertEqual(environment, {"variables": {}})
        self.assertEqual(json.loads(lock.read_text()), {"native": True})
        calls = native.call_args_list
        self.assertEqual(calls[0].args[0][-5:], ["tasks", "run", "devenv:enterShell", "--mode", "all"])
        self.assertEqual(calls[1].args[0][-2:], ["print-dev-env", "--json"])
        for call in calls:
            args = call.args[0]
            self.assertNotIn("--ro-bind", args)
            self.assertEqual(call.args[2]["AGENT_EXEC_ACTIVATING"], str(self.root))
            self.assertEqual(call.args[3], 1200)
        self.assertFalse((self.root / "cache/current.json").exists())
        self.assertFalse((self.root / "cache/error").exists())

    def test_slow_setup_reports_progress_without_corrupting_json(self):
        diagnostic = io.StringIO()
        command = [sys.executable, "-c", 'import time; print(\'{"ready":\', end="", flush=True); time.sleep(0.12); print("true}")']
        with patch.object(devenv_environment, "PROGRESS_INTERVAL", 0.03), contextlib.redirect_stderr(diagnostic):
            result = devenv_environment.run_native(command, self.root, dict(os.environ), 2, "running setup")
        self.assertEqual(json.loads(result.stdout), {"ready": True})
        self.assertIn("running setup", diagnostic.getvalue())
        self.assertNotIn("ready", diagnostic.getvalue())

    def test_setup_output_is_shown_only_when_the_step_fails_or_is_stopped(self):
        script = 'import sys; print("Running devenv:enterShell", file=sys.stderr); print("{}"); sys.exit(int(sys.argv[1]))'
        for status, expected in [(0, ""), (1, "Running devenv:enterShell\n")]:
            with contextlib.redirect_stderr(io.StringIO()) as diagnostic:
                result = devenv_environment.run_native([sys.executable, "-c", script, str(status)], self.root, dict(os.environ), 2, "running setup")
            self.assertEqual((result.returncode, diagnostic.getvalue()), (status, expected))
            self.assertEqual(result.stdout, "{}\n")
        slow = [sys.executable, "-c", 'import sys, time; print("pnpm install in progress", file=sys.stderr, flush=True); time.sleep(30)']
        with contextlib.redirect_stderr(io.StringIO()) as diagnostic, self.assertRaises(TimeoutError):
            devenv_environment.run_native(slow, self.root, dict(os.environ), 0.3, "running setup")
        self.assertIn("pnpm install in progress", diagnostic.getvalue())

    def test_setup_timeout_stops_child_processes_holding_stdout(self):
        marker = self.root / "child.pid"
        command = [sys.executable, "-c", "import os, pathlib, sys, time; pid = os.fork(); "
                   "pathlib.Path(sys.argv[1]).write_text(str(pid)) if pid else None; time.sleep(30)", str(marker)]
        with self.assertRaisesRegex(TimeoutError, "running setup timed out"):
            devenv_environment.run_native(command, self.root, dict(os.environ), 0.3, "running setup")
        pid = int(marker.read_text())
        status = Path(f"/proc/{pid}/status")
        deadline = time.monotonic() + 2
        while True:
            try:
                state = status.read_text()
            except FileNotFoundError:
                break
            if "Z (zombie)" in state:
                break
            if time.monotonic() >= deadline:
                self.fail(f"Setup child is still alive after termination:\n{state}")
            time.sleep(0.01)

    def test_competing_setup_has_progress_a_deadline_and_can_retry(self):
        diagnostic = io.StringIO()
        path = self.root / "entry.lock"
        with path.open("w") as owner, path.open("w") as waiter:
            fcntl.flock(owner, fcntl.LOCK_EX)
            with patch.object(devenv_environment, "PROGRESS_INTERVAL", 0.02), contextlib.redirect_stderr(diagnostic):
                with self.assertRaisesRegex(TimeoutError, "waiting for another workspace setup"):
                    devenv_environment.acquire_entry_lock(waiter, 0.15)
            self.assertIn("waiting for another workspace setup", diagnostic.getvalue())
            fcntl.flock(owner, fcntl.LOCK_UN)
            devenv_environment.acquire_entry_lock(waiter, 0.15)

    def test_timeout_provides_exact_repair_command_and_larger_budget_hint(self):
        (self.root / "devenv.lock").write_text("{}")
        with patch.dict(os.environ, {"AGENT_EXEC_DEVENV": "/pinned/devenv", "AGENT_EXEC_BWRAP": "/pinned/bwrap"}), patch.object(devenv_environment, "run_native", side_effect=TimeoutError("running setup timed out after 900s")):
            with self.assertRaises(ValueError) as failed:
                devenv_environment.evaluate(self.root, self.root / "cache", {})
        self.assertIn("--setup-timeout SECONDS", str(failed.exception))
        self.assertIn(devenv_environment.repair_command(self.root, {}), str(failed.exception))

    def test_nested_repair_command_uses_the_registered_host_path(self):
        command = devenv_environment.repair_command(Path("/home/user/project/packages/app"), {
            "AGENT_EXEC_ROOT": "/home/user/project",
            "AGENT_EXEC_HOST_ROOT": "/home/user/workspaces/my project",
        })
        self.assertTrue(command.startswith("agent-exec exec --cwd '/home/user/workspaces/my project/packages/app' --environment baseline -- bash\n"))
        self.assertIn("/home/user/project/packages/app/.devenv/agent-exec-baseline", command)

    def test_editor_repair_marker_bypasses_broken_setup_until_removed(self):
        (self.root / "devenv.nix").write_text("invalid Nix")
        marker = self.root / ".devenv/agent-exec-baseline"
        marker.parent.mkdir()
        marker.touch()
        settings = {"AGENT_EXEC_ROOT": str(self.root), "AGENT_EXEC_TOOL_CACHE": str(self.root / "cache"),
                    "AGENT_EXEC_BASE_PATH": os.environ["PATH"], "AGENT_EXEC_REAL_BASH": shutil.which("bash")}
        with patch.dict(os.environ, settings), patch.object(Path, "cwd", return_value=self.root), patch.object(devenv_environment, "evaluate", side_effect=ValueError("broken setup")) as evaluate, patch.object(workspaces.os, "execvpe") as execute, contextlib.redirect_stderr(io.StringIO()) as diagnostic:
            workspaces.activate(["bash", "-c", "echo repair"])
            evaluate.assert_not_called()
            self.assertIn("baseline repair mode", diagnostic.getvalue())
            self.assertEqual(execute.call_args.args[2]["PATH"], os.environ["PATH"])
            marker.unlink()
            with self.assertRaisesRegex(ValueError, "broken setup"):
                workspaces.activate(["bash", "-c", "echo normal"])

    def test_hook_and_task_exports_preserve_protocol_cwd_and_local_path(self):
        (self.root / "devenv.nix").touch()
        nested = self.root / "src"
        nested.mkdir()
        local_bin = self.root / "node_modules/.bin"
        local_bin.mkdir(parents=True)
        marker = local_bin / "local-tool"
        marker.write_text("#!/bin/sh\nprintf local-tool")
        marker.chmod(0o755)
        bash = shutil.which("bash")
        variables = {"PATH": {"type": "exported", "value": os.environ["PATH"]},
                     "HOME": {"type": "exported", "value": "/wrong"},
                     "shellHook": {"type": "exported", "value": 'echo hook-noise; export RESULT=hook'}}
        settings = {"AGENT_EXEC_ROOT": str(self.root), "AGENT_EXEC_TOOL_CACHE": str(self.root / "cache"),
                    "AGENT_EXEC_BASE_PATH": os.environ["PATH"], "AGENT_EXEC_REAL_BASH": bash,
                    "AGENT_EXEC_ENVIRONMENT_PATH": os.environ["PATH"],
                    "AGENT_EXEC_PROJECT_VARIABLES": "PATH:REMOVED_VALUE",
                    "REMOVED_VALUE": "previous definition",
                    "PATH": str(local_bin) + ":" + os.environ["PATH"]}
        result_text = "task's result\nnext line"
        with patch.dict(os.environ, settings), patch.object(Path, "cwd", return_value=nested), patch.object(devenv_environment, "evaluate", return_value=({"variables": variables}, {"RESULT": result_text})), patch.object(workspaces.os, "execvpe") as execute:
            workspaces.activate([bash, "-c", 'printf "%s|%s|%s|%s" "$RESULT" "$PWD" "${AGENT_EXEC_ACTIVATING-unset}" "$(local-tool)"'])
        _, argv, env = execute.call_args.args
        result = subprocess.run(argv, env=env, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, result_text + "|" + str(nested) + "|unset|local-tool")
        self.assertEqual(result.stderr, "hook-noise\n")
        self.assertEqual(env["HOME"], os.environ["HOME"])
        self.assertNotIn("REMOVED_VALUE", env)

    def test_plain_directory_cache_is_masked_but_private_state_is_retained(self):
        source, upper = self.root / "source", self.root / "upper"
        nested = source / "team/app"
        (nested / ".devenv").mkdir(parents=True)
        (nested / "devenv.nix").touch()
        (nested / ".devenv/host-state").write_text("source")
        private = upper / "team/app/.devenv"
        private.mkdir(parents=True)
        (private / "private-state").write_text("retained")
        project_files.isolate_devenv_directories(source, upper)
        self.assertTrue((upper / ".unionfs/team/app/.devenv_HIDDEN~").is_dir())
        self.assertEqual((private / "private-state").read_text(), "retained")
        self.assertFalse((private / "host-state").exists())
