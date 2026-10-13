import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import agent_exec as runtime
import workspaces
import project_files


class IndependentWorkspaceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        (self.base / "home").mkdir()
        for context in [
            patch.object(runtime, "STATE", self.base / "state"),
            patch.object(runtime, "PUBLISH_ROOT", self.base / "published"),
            patch.object(workspaces, "pin_profile"),
            patch.dict(
                os.environ,
                {
                    "AGENT_EXEC_BASE_PROFILE": str(self.base),
                    "JJ_CONFIG": "",
                    "HOME": str(self.base / "home"),
                    "XDG_CONFIG_HOME": str(self.base / "home/.config"),
                },
            ),
        ]:
            context.start()
            self.addCleanup(context.stop)

    def make_source(self):
        source = self.base / "source"
        subprocess.run(["jj", "git", "init", str(source)], check=True, capture_output=True)
        workspaces.jj(source, "config", "set", "--repo", "user.name", "Workspace test")
        workspaces.jj(source, "config", "set", "--repo", "user.email", "test@example.invalid")
        (source / "app.txt").write_text("base")
        (source / "t3.json").write_text('{"defaultThreadEnvMode":"worktree"}\n')
        workspaces.jj(source, "describe", "-m", "base", snapshot=True)
        workspaces.jj(source, "bookmark", "create", "main", "-r", "@")
        return source

    def test_stable_runtime_paths_resolve_to_each_workspace_generation(self):
        for name in ["a", "b"]:
            record = {"root": str(self.base / name), "home": "/home/agent",
                      "workspace": {"visibleRoot": "/home/agent/project", "stableRuntimePath": True}}
            state = runtime.project_state(record)
            state.mkdir(parents=True)
            # Ordinary paths also work before the process namespace starts.
            self.assertEqual(workspaces.host_path(runtime, record, "/home/agent/project/file"),
                             self.base / name / "file")
            for generation in ["first", "second"]:
                (state / "process-namespace.json").write_text(json.dumps({"runtime": "/tmp/runtime/" + generation}))
                self.assertEqual(workspaces.host_path(runtime, record, "/tmp/runtime/socket"),
                                 state / "tmp/runtime" / generation / "socket")

    @unittest.skipUnless(shutil.which("jj"), "jj is needed for repository integration")
    def test_t3_creation_retry_preserves_workspace_edits_and_project_configuration(self):
        source = self.make_source()
        destination = self.base / "checkout"
        options = {"workspace_id": "workspace:one", "project_id": "project:one"}
        first = workspaces.fork(runtime, source, destination, "project", "@", "familiar", **options)
        self.assertEqual((source / "t3.json").read_bytes(), (destination / "t3.json").read_bytes())
        (destination / "app.txt").write_text("unfinished work")
        again = workspaces.fork(runtime, source, destination, "project", "@", "familiar", **options)
        self.assertEqual(first, again)
        self.assertEqual((destination / "app.txt").read_text(), "unfinished work")
        with self.assertRaisesRegex(ValueError, "does not match"):
            workspaces.fork(runtime, source, destination, "project", "@", "minimal", **options)

    @unittest.skipUnless(shutil.which("jj"), "jj is needed for repository integration")
    def test_fork_from_shared_jj_workspace_uses_its_backing_repository(self):
        source = self.make_source()
        shared = self.base / "shared"
        workspaces.jj(source, "workspace", "add", "--name", "shared", "-r", "@", str(shared), snapshot=True)
        (shared / "app.txt").write_text("shared checkout changes")
        destination = self.base / "independent"
        workspaces.fork(runtime, shared, destination, "project", "@", "minimal")
        self.assertEqual((destination / "app.txt").read_text(), "shared checkout changes")
        self.assertEqual(workspaces.jj(destination, "git", "remote", "list"), "")

    @unittest.skipUnless(shutil.which("jj") and shutil.which("git"), "Git and jj are needed")
    def test_git_project_round_trip_preserves_unfinished_source_work(self):
        source = self.make_source()
        workspaces.jj(source, "new", "main", snapshot=True)
        shutil.rmtree(source / ".jj")
        before = workspaces.git(source, "rev-parse", "HEAD")
        (source / "app.txt").write_text("unfinished source work")
        destination = self.base / "independent"
        workspaces.fork(runtime, source, destination, "project", "HEAD", "minimal", workspace_id="workspace:git", project_id="project:git")
        self.assertEqual((destination / "app.txt").read_text(), "base")
        (destination / "app.txt").write_text("completed change")
        result = workspaces.collect(destination, source, "@")
        self.assertEqual(workspaces.git(source, "rev-parse", "HEAD"), before)
        self.assertEqual((source / "app.txt").read_text(), "unfinished source work")
        self.assertEqual(workspaces.git(source, "show", result["bookmark"] + ":app.txt"), "completed change")
        self.assertEqual(workspaces.git(source, "for-each-ref", "refs/heads/agent-transfer-*"), "")

    @unittest.skipUnless(shutil.which("jj") and shutil.which("git"), "Git and jj are needed")
    def test_forks_inherit_remotes_without_sharing_config_or_hooks(self):
        source = self.make_source()
        backing = workspaces.repository_directory(source)
        def config(*args):
            subprocess.run(["git", "--git-dir", backing, "config", *args], check=True)
        config("remote.origin.url", "https://example.invalid/team/project.git")
        config("remote.origin.pushurl", "git@example.invalid:team/project.git")
        config("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
        config("--add", "remote.origin.pushurl", "ssh://mirror.invalid/project.git")
        config("remote.upstream.url", "https://example.invalid/upstream/project.git")
        config("core.hooksPath", "/source-only-hooks")
        shared = self.base / "shared"
        workspaces.jj(source, "workspace", "add", "--name", "shared", "-r", "@", str(shared), snapshot=True)
        destination = self.base / "independent"
        workspaces.fork(runtime, shared, destination, "project", "@", "minimal")
        self.assertEqual(workspaces.git(destination, "remote"), "origin\nupstream")
        self.assertIn("origin https://example.invalid/team/project.git", workspaces.jj(destination, "git", "remote", "list"))
        self.assertEqual(workspaces.git(destination, "config", "--get-all", "remote.origin.pushurl"),
                         "git@example.invalid:team/project.git\nssh://mirror.invalid/project.git")
        self.assertEqual(workspaces.git(destination, "config", "remote.origin.fetch"), "+refs/heads/*:refs/remotes/origin/*")
        self.assertNotEqual(subprocess.run(["git", "-C", str(destination), "config", "--get", "core.hooksPath"], capture_output=True).returncode, 0)
        workspaces.git(destination, "remote", "set-url", "origin", "https://override.invalid/project.git")
        workspaces.inherit_remotes(shared, destination)
        self.assertEqual(workspaces.git(destination, "remote", "get-url", "origin"), "https://override.invalid/project.git")
        self.assertEqual(subprocess.check_output(["git", "--git-dir", backing, "config", "remote.origin.url"], text=True).strip(), "https://example.invalid/team/project.git")

    @unittest.skipUnless(shutil.which("jj") and shutil.which("git"), "Git and jj are needed")
    def test_git_fork_can_fetch_and_push_via_inherited_relative_remote(self):
        source = self.make_source()
        workspaces.jj(source, "new", "main", snapshot=True)
        shutil.rmtree(source / ".jj")
        remote = self.base / "upstream.git"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
        workspaces.git(source, "remote", "add", "origin", "../upstream.git")
        workspaces.git(source, "push", "origin", "main")
        destination = self.base / "nested/independent"
        destination.parent.mkdir()
        workspaces.fork(runtime, source, destination, "project", "HEAD", "minimal")
        self.assertEqual(workspaces.git(destination, "remote", "get-url", "origin"), str(remote))
        workspaces.jj(destination, "git", "fetch", "--remote", "origin")
        self.assertEqual(workspaces.jj(destination, "log", "-r", "main@origin", "--no-graph", "-T", "commit_id"),
                         workspaces.git(source, "rev-parse", "main"))
        workspaces.git(destination, "push", "origin", "HEAD:refs/heads/workspace-proof")
        self.assertEqual(workspaces.git(remote, "rev-parse", "workspace-proof"), workspaces.git(destination, "rev-parse", "HEAD"))

    def test_namespace_paths_are_scoped_and_normalized(self):
        records = [
            {
                "root": str(self.base / name),
                "home": "/home/agent",
                "workspace": {"visibleRoot": "/home/agent/project"},
            }
            for name in ["a", "b"]
        ]
        first, second = [
            workspaces.host_path(runtime, r, "/home/agent/project/image.png")
            for r in records
        ]
        self.assertNotEqual(first, second)
        published = runtime.publish_directory(records[0]) / "image.png"
        self.assertEqual(workspaces.host_path(runtime, records[0], published), published)
        self.assertEqual(workspaces.host_path(runtime, records[0], "/srv/agent-share/image.png"), published)
        sibling = runtime.publish_directory(records[1]) / "image.png"
        try:
            mapped_sibling = workspaces.host_path(runtime, records[0], sibling)
        except ValueError:
            mapped_sibling = None
        self.assertNotEqual(mapped_sibling, sibling)
        self.assertEqual(first, self.base / "a/image.png")
        self.assertEqual(
            workspaces.host_path(runtime, records[0], "/tmp/a/../image.png"),
            runtime.project_state(records[0]) / "tmp/image.png",
        )
        with self.assertRaises(ValueError):
            workspaces.host_path(runtime, records[0], "/home/agent/../../etc/passwd")

    @unittest.skipUnless(shutil.which("jj"), "jj is needed for repository integration")
    def test_directory_project_discovers_deep_repos_and_forks_linked_workspaces(self):
        group = self.base / "group"
        source = group / "repos/team/deep/app"
        source.parent.mkdir(parents=True)
        self.make_source().rename(source)
        linked = group / "other/deep/linked"
        linked.parent.mkdir(parents=True)
        workspaces.jj(source, "workspace", "add", "--name", "linked", "-r", "@", str(linked), snapshot=True)
        (linked / "app.txt").write_text("linked revision")
        git_linked = group / "native/git-linked"
        git_linked.parent.mkdir(parents=True)
        commit = workspaces.jj(source, "log", "-r", "@", "--no-graph", "-T", "commit_id")
        workspaces.git(source, "worktree", "add", "--detach", str(git_linked), commit)
        (git_linked / "app.txt").write_text("uncommitted Git worktree edit")
        (group / "notes.txt").write_text("live project notes")
        (group / "node_modules/ignored/.git").mkdir(parents=True)
        (group / "external-link").symlink_to(source, target_is_directory=True)
        destination = self.base / "directory-workspace"
        options = {"workspace_id": "workspace:directory", "project_id": "project:group"}
        with patch.object(project_files, "ensure"), patch.object(workspaces, "fork_repository", wraps=workspaces.fork_repository) as clone:
            record = workspaces.fork(runtime, group, destination, "group", "HEAD", "minimal", **options)
            self.assertEqual(clone.call_count, 3)
            self.assertEqual(record["workspace"]["layout"], "directory")
            self.assertTrue(record["workspace"]["ready"])
            self.assertIsNone(record["workspace"]["sourceRevision"])
            self.assertEqual([r["path"] for r in record["workspace"]["repositories"]], ["native/git-linked", "other/deep/linked", "repos/team/deep/app"])
            upper = runtime.project_state(record) / "files"
            self.assertFalse((upper / "notes.txt").exists())
            self.assertFalse((upper / "node_modules").exists())
            self.assertEqual((upper / "other/deep/linked/app.txt").read_text(), "linked revision")
            self.assertEqual((upper / "native/git-linked/app.txt").read_text(), "base")
            self.assertEqual(workspaces.jj(upper / "repos/team/deep/app", "git", "remote", "list"), "")
            self.assertTrue((upper / ".unionfs/repos/team/deep/app_HIDDEN~").is_dir())
            (upper / "repos/team/deep/app/app.txt").write_text("unfinished independent edit")
            record["workspace"]["ready"] = False
            runtime.write_text(runtime.record_path(destination), json.dumps(record))
            retried = workspaces.fork(runtime, group, destination, "group", "HEAD", "minimal", **options)
            self.assertTrue(retried["workspace"]["ready"])
            self.assertEqual(clone.call_count, 3)
            self.assertEqual((upper / "repos/team/deep/app/app.txt").read_text(), "unfinished independent edit")
            self.assertEqual((source / "app.txt").read_text(), "base")

    def test_plain_directory_preparation_does_not_copy_source_files(self):
        source = self.base / "plain"
        source.mkdir()
        (source / "large-file").write_text("source contents")
        with patch.object(project_files, "ensure"):
            record = workspaces.fork(runtime, source, self.base / "view", "plain", "HEAD", "minimal",
                                     workspace_id="workspace:plain", project_id="project:plain")
        self.assertTrue(record["workspace"]["ready"])
        self.assertEqual(record["workspace"]["repositories"], [])
        self.assertEqual(list((runtime.project_state(record) / "files").iterdir()), [])

    def test_cannot_delete_a_directory_source_still_used_by_another_workspace(self):
        root = self.base / "first"
        root.mkdir()
        dependent = {"version": 1, "root": str(self.base / "second"),
                     "workspace": {"layout": "directory", "sourceRoot": str(root)}}
        runtime.record_path(dependent["root"]).parent.mkdir(parents=True)
        runtime.write_text(runtime.record_path(dependent["root"]), json.dumps(dependent))
        with patch.object(runtime, "run") as run, self.assertRaisesRegex(ValueError, "still reads"):
            project_files.remove_checkout(runtime, {"root": str(root), "workspace": {"layout": "directory"}})
        run.assert_not_called()
        self.assertTrue(root.exists())

    def test_deleting_a_workspace_removes_its_private_state(self):
        root = self.base / "workspace"
        root.mkdir()
        record = {"version": 1, "root": str(root), "workspace": {"layout": "repository"}}
        runtime.record_path(root).parent.mkdir(parents=True)
        runtime.write_text(runtime.record_path(root), json.dumps(record))
        module = runtime.project_state(record) / "home/go/pkg/mod/example"
        module.mkdir(parents=True)
        (module / "go.mod").write_text("module example\n")
        module.chmod(0o555)
        environments = runtime.STATE / "environments"
        (environments / ".removed-interrupted/home").mkdir(parents=True)
        other = runtime.project_state({"root": str(self.base / "other")})
        other.mkdir()

        project_files.remove_checkout(runtime, record)

        self.assertFalse(root.exists())
        self.assertFalse(runtime.record_path(root).exists())
        self.assertEqual(list(environments.iterdir()), [other])

    @unittest.skipUnless(shutil.which("jj"), "jj is needed for repository integration")
    def test_fork_and_collect_preserve_change_identity_and_other_unfinished_work(self):
        source = self.base / "source"
        subprocess.run(
            ["jj", "git", "init", str(source)], check=True, capture_output=True
        )
        for name, value in [
            ("user.name", "Environment test"),
            ("user.email", "test@example.invalid"),
        ]:
            workspaces.jj(source, "config", "set", "--repo", name, value)
        (source / "app.txt").write_text("base")
        workspaces.jj(source, "describe", "-m", "base", snapshot=True)
        original = workspaces.jj(
            source, "log", "-r", "@", "--no-graph", "-T", "commit_id"
        )
        first = workspaces.fork(
            runtime, source, self.base / "first", "project", "@", "minimal"
        )
        second = workspaces.fork(
            runtime, source, self.base / "second", "project", "@", "familiar"
        )
        self.assertEqual(
            first["workspace"]["visibleRoot"], second["workspace"]["visibleRoot"]
        )
        self.assertEqual(
            workspaces.jj(source, "log", "-r", "@", "--no-graph", "-T", "commit_id"),
            original,
        )
        self.assertNotEqual(
            (self.base / "first/.jj/repo").stat().st_ino,
            (self.base / "second/.jj/repo").stat().st_ino,
        )
        self.assertEqual(
            workspaces.jj(self.base / "first", "git", "remote", "list"), ""
        )
        (self.base / "first/app.txt").write_text("first change")
        workspaces.jj(
            self.base / "first", "describe", "-m", "selected change", snapshot=True
        )
        change = workspaces.jj(
            self.base / "first", "log", "-r", "@", "--no-graph", "-T", "change_id"
        )
        (self.base / "second/unfinished.txt").write_text("do not touch")
        before = workspaces.jj(
            self.base / "second", "log", "-r", "@", "--no-graph", "-T", "commit_id"
        )
        result = workspaces.collect(self.base / "first", self.base / "second", "@")
        self.assertEqual(result["change"], change)
        self.assertEqual(
            workspaces.jj(
                self.base / "second", "log", "-r", "@", "--no-graph", "-T", "commit_id"
            ),
            before,
        )
        self.assertEqual(
            (self.base / "second/unfinished.txt").read_text(), "do not touch"
        )
        self.assertEqual((self.base / "second/app.txt").read_text(), "base")
        self.assertEqual(
            workspaces.jj(self.base / "second", "git", "remote", "list"), ""
        )

    def test_environment_refresh_keeps_last_good_tools_on_failure(self):
        root, cache = self.base / "project", self.base / "cache"
        root.mkdir()
        (root / "flake.nix").write_text("first")
        variables = {
            "PATH": {"type": "exported", "value": "/tools/bin"},
            "HOME": {"type": "exported", "value": "/wrong-home"},
        }
        with (
            patch.dict(
                os.environ,
                {
                    "AGENT_EXEC_ROOT": str(root),
                    "AGENT_EXEC_TOOL_CACHE": str(cache),
                    "AGENT_EXEC_BASE_PATH": "/base/bin",
                    "AGENT_EXEC_REAL_BASH": "/real/bash",
                },
            ),
            patch.object(workspaces.os, "execvpe") as execute,
            patch.object(workspaces.subprocess, "run") as build,
        ):
            build.return_value = subprocess.CompletedProcess(
                [], 0, json.dumps({"variables": variables}), ""
            )
            workspaces.activate(["bash", "-c", "command -v tool"])
            self.assertEqual(execute.call_args.args[0], "/real/bash")
            self.assertEqual(
                execute.call_args.args[2]["PATH"],
                "/run/agent-exec-bin:/tools/bin:/base/bin",
            )
            self.assertNotEqual(execute.call_args.args[2]["HOME"], "/wrong-home")
            workspaces.activate(["true"])
            self.assertEqual(build.call_count, 1)
            dependency = root / ".pnpm-store" / "package" / "build.nix"
            dependency.parent.mkdir(parents=True)
            dependency.write_text("package-manager cache")
            workspaces.activate(["true"])
            self.assertEqual(build.call_count, 1)
            imported = root / "nix" / "tools.nix"
            imported.parent.mkdir()
            imported.write_text("project tools")
            workspaces.activate(["true"])
            self.assertEqual(build.call_count, 2)
            (root / "flake.nix").write_text("broken")
            build.return_value = subprocess.CompletedProcess(
                [], 1, "", "invalid definition"
            )
            workspaces.activate(["true"])
            self.assertEqual(
                execute.call_args.args[2]["PATH"],
                "/run/agent-exec-bin:/tools/bin:/base/bin",
            )
            self.assertEqual((cache / "error").read_text(), "invalid definition")
            # A failed key waits before re-evaluating; changed inputs retry at once.
            workspaces.activate(["true"])
            self.assertEqual(build.call_count, 3)
            with patch.object(workspaces.time, "time", return_value=time.time() + 61):
                workspaces.activate(["true"])
            self.assertEqual(build.call_count, 4)
            (root / "flake.nix").write_text("broken differently")
            workspaces.activate(["true"])
            self.assertEqual(build.call_count, 5)

    def test_new_files_in_jj_repository_become_visible_to_nix(self):
        repository, cache = self.base / "project", self.base / "cache"
        subprocess.run(["jj", "git", "init", "--colocate", str(repository)], check=True, capture_output=True)
        workspaces.jj(repository, "config", "set", "--repo", "snapshot.max-new-file-size", "100")
        root = repository / "tools"
        root.mkdir()
        cache.mkdir()
        (root / "flake.nix").write_text("{ }")
        (root / "package.json").write_text("{}")
        (root / "large.bin").write_bytes(b"x" * 1000)
        with patch.object(workspaces.tool_environments.subprocess, "run", wraps=subprocess.run) as run:
            workspaces.tool_environments.snapshot_untracked_files(root, cache, os.environ["PATH"])
            workspaces.tool_environments.snapshot_untracked_files(root, cache, os.environ["PATH"])
        tracked = subprocess.run(
            ["git", "-C", str(repository), "ls-files"], check=True, capture_output=True, text=True
        ).stdout.split()
        self.assertEqual(sorted(tracked), ["tools/flake.nix", "tools/package.json"])
        # jj declined the oversized file once; later activations do not retry it.
        self.assertEqual([call.args[0][0] for call in run.call_args_list], ["git", "jj", "git", "git"])

    def test_environment_failure_names_nix_error_jj_fix_and_nested_log(self):
        root, cache = self.base / "project", self.base / "tools"
        subprocess.run(["jj", "git", "init", "--colocate", str(root)], check=True, capture_output=True)
        stderr = "warning: Git tree is dirty\nerror:\n       … while fetching\n\n       error: Path 'flake.nix' is not tracked by Git.\n"
        with patch.dict(os.environ, {"AGENT_EXEC_TOOL_CACHE": str(cache)}):
            message = workspaces.environment_failure(root, cache / "nested/abc", stderr)
        self.assertEqual(message.splitlines()[1:], [
            "  error: Path 'flake.nix' is not tracked by Git.",
            "  In this jj repository, run `jj st` instead to track new files; it reports why a snapshot fails.",
            "Full log: ~/.local/state/agent-environment/nested/abc/error. Retrying after 60 s or when project files change.",
        ])

    def test_nested_package_shells_keep_local_bins_when_project_tools_refresh(self):
        root, cache = self.base / "project", self.base / "cache"
        root.mkdir()
        (root / "flake.nix").write_text("first")
        with (
            patch.dict(os.environ, {
                "AGENT_EXEC_ROOT": str(root),
                "AGENT_EXEC_TOOL_CACHE": str(cache),
                "AGENT_EXEC_BASE_PATH": "/base/bin",
                "AGENT_EXEC_REAL_BASH": "/real/bash",
                "PATH": "/host-only/bin",
            }, clear=True),
            patch.object(workspaces.os, "execvpe") as execute,
            patch.object(workspaces.subprocess, "run") as build,
        ):
            build.return_value = subprocess.CompletedProcess(
                [], 0, json.dumps({"variables": {"PATH": {"type": "exported", "value": "/old-tools/bin"}}}), ""
            )
            workspaces.activate(["pnpm", "install"])
            first = execute.call_args.args[2]
            self.assertNotIn("/host-only/bin", first["PATH"])
            local_bins = str(root / "node_modules/.bin")
            os.environ.update(first, PATH=local_bins + os.pathsep + first["PATH"])
            workspaces.activate(["/bin/sh", "-c", "node-gyp-build"])
            nested = execute.call_args.args[2]
            self.assertEqual(nested["PATH"].split(os.pathsep)[0], local_bins)
            # A second shell must retain additions without treating them as old Nix tools.
            os.environ.update(nested)
            (root / "flake.nix").write_text("updated")
            build.return_value = subprocess.CompletedProcess(
                [], 0, json.dumps({"variables": {"PATH": {"type": "exported", "value": "/new-tools/bin"}}}), ""
            )
            workspaces.activate(["/bin/sh", "-c", "node-gyp-build"])
            refreshed = execute.call_args.args[2]["PATH"].split(os.pathsep)
            self.assertEqual(refreshed[0], local_bins)
            self.assertIn("/new-tools/bin", refreshed)
            self.assertNotIn("/old-tools/bin", refreshed)
            self.assertNotIn("/host-only/bin", refreshed)

    @unittest.skipUnless(shutil.which("jj"), "jj is needed for tracked source identity")
    def test_shared_environment_reuses_evaluation_and_invalidates_non_nix_inputs(self):
        root = self.make_source()
        (root / "flake.nix").write_text("a development shell that reads config.json")
        (root / "config.json").write_text('{"version":1}')
        # Activation snapshots untracked files, so dependency caches must be ignored.
        (root / ".gitignore").write_text("node_modules/\n")
        workspaces.jj(root, "describe", "-m", "environment", snapshot=True)
        workspaces.jj(root, "new", snapshot=True)
        shared = self.base / "shared-tools"
        first, second, third = [self.base / name for name in ("cache-a", "cache-b", "cache-c")]
        real_run = subprocess.run
        evaluations = []

        def evaluate(command, **kwargs):
            if command[0] != "nix":
                return real_run(command, **kwargs)
            evaluations.append(command)
            return subprocess.CompletedProcess(command, 0, json.dumps({"variables": {
                "PATH": {"type": "exported", "value": "/shared-tools/bin"},
            }}), "")

        with patch.dict(os.environ, {
            "AGENT_EXEC_ROOT": str(root), "AGENT_EXEC_TOOL_CACHE": str(first),
            "AGENT_EXEC_SHARED_TOOL_CACHE": str(shared),
            "AGENT_EXEC_BASE_PATH": os.environ["PATH"], "AGENT_EXEC_REAL_BASH": "/real/bash",
        }), patch.object(workspaces.subprocess, "run", side_effect=evaluate), patch.object(workspaces.os, "execvpe") as execute:
            workspaces.activate(["true"])
            os.environ["AGENT_EXEC_TOOL_CACHE"] = str(second)
            workspaces.activate(["true"])
            self.assertEqual(len(evaluations), 1)
            self.assertEqual(json.loads((first / "current.json").read_text()), json.loads((second / "current.json").read_text()))
            self.assertTrue(list(shared.glob("*/environment.json")))
            (root / "config.json").write_text('{"version":2}')
            os.environ["AGENT_EXEC_TOOL_CACHE"] = str(third)
            workspaces.activate(["true"])
            self.assertEqual(len(evaluations), 2)
            self.assertIn("/shared-tools/bin", execute.call_args.args[2]["PATH"])
            (root / "node_modules").mkdir()
            (root / "node_modules/unused").write_text("dependency cache")
            workspaces.activate(["true"])
            self.assertEqual(len(evaluations), 2)

    @unittest.skipUnless(shutil.which("jj"), "jj is needed for tracked source identity")
    def test_environment_changed_during_evaluation_is_not_shared(self):
        root = self.make_source()
        (root / "flake.nix").write_text("first definition")
        workspaces.jj(root, "describe", "-m", "environment", snapshot=True)
        workspaces.jj(root, "new", snapshot=True)
        shared = self.base / "shared-tools"
        real_run = subprocess.run

        def evaluate(command, **kwargs):
            if command[0] != "nix":
                return real_run(command, **kwargs)
            (root / "flake.nix").write_text("changed while evaluating")
            return subprocess.CompletedProcess(command, 0, '{"variables":{}}', "")

        with patch.dict(os.environ, {
            "AGENT_EXEC_ROOT": str(root), "AGENT_EXEC_TOOL_CACHE": str(self.base / "local-tools"),
            "AGENT_EXEC_SHARED_TOOL_CACHE": str(shared),
            "AGENT_EXEC_BASE_PATH": os.environ["PATH"], "AGENT_EXEC_REAL_BASH": "/real/bash",
        }), patch.object(workspaces.subprocess, "run", side_effect=evaluate), patch.object(workspaces.os, "execvpe"):
            workspaces.activate(["true"])
        self.assertEqual(list(shared.glob("*/environment.json")), [])
        self.assertEqual(json.loads((self.base / "local-tools/current.json").read_text())["fingerprint"], "changed-during-evaluation")
