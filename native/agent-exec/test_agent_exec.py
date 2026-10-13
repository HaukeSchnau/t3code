import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import agent_exec as runtime


class ProjectEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        environment = patch.dict(runtime.os.environ, {"AGENT_EXEC_REAL_BASH": "/bin/bash"})
        environment.start()
        self.addCleanup(environment.stop)
        self.state = patch.object(runtime, "STATE", self.base / "state")
        self.state.start()
        self.addCleanup(self.state.stop)
        publish = patch.object(runtime, "PUBLISH_ROOT", self.base / "published")
        publish.start()
        self.addCleanup(publish.stop)
        self.bridge = patch.object(runtime, "ensure_bridge")
        self.bridge.start()
        self.addCleanup(self.bridge.stop)

    def test_managed_login_startup_restores_project_tools_and_preserves_custom_files(self):
        startup = self.base / ".bash_profile"
        startup.write_text('export PATH="/run/agent-exec-bin:$PATH"\n')
        runtime.update_shell_startup(startup)
        tools = self.base / "tools"
        tools.mkdir()
        executable = tools / "project-tool"
        executable.write_text("#!/bin/sh\necho project-tool\n")
        executable.chmod(0o755)
        result = subprocess.run(["bash", "--noprofile", "--norc", "-c",
                                 'PATH=/usr/bin:/bin; source "$1"; command -v project-tool', "test", str(startup)],
                                env={**runtime.os.environ, "AGENT_EXEC_ENVIRONMENT_PATH": str(tools)},
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), str(executable))
        startup.write_text("# user-managed startup\n")
        runtime.update_shell_startup(startup)
        self.assertEqual(startup.read_text(), "# user-managed startup\n")

    def test_hosts_without_the_file_share_still_launch(self):
        record = runtime.create(self.base / "project")
        with patch.object(runtime, "PUBLISH_ROOT", self.base / "missing-share" / "isolated"):
            with patch.object(runtime.os, "execvp") as execute:
                runtime.launch(record, record["root"], ["true"])
        args = execute.call_args.args[1]
        mounted = Path(args[args.index("/srv/agent-share") - 1])
        self.assertTrue(mounted.is_relative_to(runtime.project_state(record)))
        self.assertFalse((self.base / "missing-share").exists())
        self.assertNotIn("AGENT_SHARE_URL", args)

    def test_publishing_has_a_distinct_directory_per_project(self):
        first = runtime.create(self.base / "first")
        second = runtime.create(self.base / "second")
        own = runtime.publish_directory(first)
        other = runtime.publish_directory(second)
        (other / "private-example.html").write_text("another project")
        self.assertNotEqual(own, other)
        with patch.object(runtime.os, "execvp") as execute:
            runtime.launch(first, first["root"], ["true"])
        args = execute.call_args.args[1]
        target = args.index("/srv/agent-share")
        self.assertEqual(args[target - 1], str(own))
        self.assertNotIn(str(other), args)
        self.assertFalse((own / "private-example.html").exists())

    def test_t3_device_cli_path_runs_the_capability_wrapper(self):
        record = runtime.create(self.base / "project")
        t3_home = Path(record["home"]) / ".t3"
        # Earlier releases left a read-only mount point placeholder here.
        target = (runtime.project_state(record) / "home/.t3"
                  / "userdata/device/bin/agent-device")
        target.parent.mkdir(parents=True)
        target.touch(0o444)
        with patch.dict(runtime.os.environ, {"T3CODE_HOME": str(t3_home)}), \
                patch.object(runtime.os, "execvp"):
            runtime.launch(record, record["root"], ["true"])
        self.assertIn("capability agent-device", target.read_text())
        self.assertTrue(runtime.os.access(target, runtime.os.X_OK))

    def test_jj_user_settings_do_not_mount_host_repository_state(self):
        record = runtime.create(self.base / "project")
        home = self.base / "home"
        record["home"] = str(home)
        settings = home / ".config/jj"
        settings.mkdir(parents=True)
        (settings / "config.toml").write_text('[user]\nname = "Test"\n')
        (settings / "repos").mkdir()
        (settings / "workspaces").mkdir()
        with patch.object(runtime.os, "execvp") as execute:
            runtime.launch(record, record["root"], ["true"])
        args = execute.call_args.args[1]
        self.assertIn(str(settings / "config.toml"), args)
        self.assertNotIn(str(settings), args)
        self.assertNotIn(str(settings / "repos"), args)
        self.assertNotIn(str(settings / "workspaces"), args)
        self.assertTrue((runtime.project_state(record) / "home/.config/jj").is_dir())

    def test_registration_is_idempotent_and_follows_descendants_not_siblings(self):
        root = self.base / "project"
        first = runtime.create(root, "p1")
        (root / "src").mkdir()
        (root / "app.ts").write_text("application")
        self.assertEqual(runtime.create(root, "p1"), first)
        self.assertEqual(runtime.lookup(root / "src"), first)
        self.assertIsNone(runtime.lookup(self.base / "project-other"))
        rebound = runtime.create(root, "p2")
        self.assertEqual(rebound["projectId"], "p2")
        self.assertEqual(runtime.lookup(root), rebound)
        self.assertEqual((root / "app.ts").read_text(), "application")
        with self.assertRaises(ValueError):
            runtime.create(root / "nested", "nested")

    def test_readding_deleted_root_preserves_environment_and_recreates_directory(self):
        root = self.base / "project"
        first = runtime.create(root, "original")
        state = runtime.project_state(first)
        (state / "keep").write_text("environment state")
        (root / "t3.json").unlink()
        root.rmdir()
        rebound = runtime.create(root, "replacement")
        self.assertTrue(root.is_dir())
        self.assertEqual(rebound["projectId"], "replacement")
        self.assertEqual((state / "keep").read_text(), "environment state")
        self.assertEqual(
            json.loads((root / "t3.json").read_text())["defaultThreadEnvMode"], "local"
        )

    def test_refuses_existing_project_without_changing_files(self):
        root = self.base / "existing"
        root.mkdir()
        (root / "important").write_text("keep")
        with self.assertRaises(ValueError):
            runtime.create(root)
        self.assertIsNone(runtime.lookup(root))
        self.assertEqual((root / "important").read_text(), "keep")

    def test_service_process_reenters_environment_and_names_are_project_scoped(self):
        record = runtime.create(self.base / "project")
        command = runtime.service_command(
            record, ["run", "preview", "--port", "auto", "--", "node", "app.js"]
        )
        self.assertTrue(command[2].startswith("px-"))
        self.assertEqual(
            command[-7:],
            [runtime.LAUNCHER, "exec", "--cwd", record["root"], "--", "node", "app.js"],
        )
        self.assertEqual(
            runtime.service_command(record, ["stop", "preview"])[2], command[2]
        )
        outside = self.base / "outside"
        outside.mkdir()
        (Path(record["root"]) / "escape").symlink_to(outside)
        with self.assertRaises(ValueError):
            runtime.service_command(
                record,
                [
                    "run",
                    "preview",
                    "--cwd",
                    str(Path(record["root"]) / "escape"),
                    "--",
                    "pwd",
                ],
            )

    def test_service_output_uses_guest_paths_and_ports(self):
        record = runtime.create(self.base / "project")
        record["workspace"] = {"visibleRoot": "/home/agent/project"}
        metadata = {"port": 19016, "command": ["agent-exec", "workspace-service", "--cwd", record["root"], "--port", "3000", "--", "node", "server.mjs"]}
        output = runtime.service_output(record, ["inspect", "preview"], metadata,
            f"  port:      19016\n  cwd:       {record['root']}\n  url: https://preview.example\n")
        self.assertIn("port:      3000", output)
        self.assertIn("cwd:       /home/agent/project", output)
        self.assertIn("https://preview.example", output)
        self.assertNotIn("19016", output)
        self.assertNotIn(record["root"], output)
        self.assertIn("agent-service verify", output)
        self.assertEqual(runtime.service_output(record, ["logs", "preview"], metadata, "raw process output"), "raw process output")

    def test_credentials_keep_native_storage_and_claude_history_is_masked(self):
        record = runtime.create(self.base / "project")
        home = self.base / "home"
        record["home"] = str(home)
        codex = home / ".codex"
        claude = home / ".claude"
        codex.mkdir(parents=True)
        claude.mkdir()
        (codex / "auth.json").write_text("test-credential")
        (claude / ".credentials.json").write_text("test-credential")
        (claude / "projects").mkdir()
        with (
            patch.dict(runtime.os.environ, {"CODEX_HOME": str(codex)}),
            patch.object(runtime.os, "execvp") as execute,
        ):
            runtime.launch(record, record["root"], ["true"])
        args = execute.call_args.args[1]
        index = args.index(str(codex / "auth.json"))
        self.assertEqual(args[index - 1], "--bind")
        private = runtime.project_state(record)
        self.assertFalse(
            (private / "codex" / runtime.identity(codex) / "auth.json").exists()
        )
        self.assertIn(str(private / "home/.claude/projects"), args)
        self.assertEqual((claude / ".credentials.json").read_text(), "test-credential")

    def test_ssh_config_includes_are_owned_and_cycles_terminate(self):
        home = self.base / "home"
        ssh = home / ".ssh"
        fragments = ssh / "fragments"
        fragments.mkdir(parents=True)
        config = ssh / "config"
        included = fragments / "fleet.conf"
        config.write_text("Include fragments/*.conf\n")
        included.write_text("Include config\nHost example\n  HostName example.test\n")
        state = self.base / "ssh-state"
        state.mkdir()
        args = []
        runtime.bind_ssh_configs(args, state, home)
        for source in (config, included):
            index = args.index(str(source.resolve()))
            owned = Path(args[index - 1])
            self.assertEqual(owned.read_text(), source.read_text())
            self.assertEqual(owned.stat().st_mode & 0o777, 0o600)
            self.assertEqual(args.count(str(source.resolve())), 1)

    def test_ssh_multiplexing_sockets_under_readonly_ssh_directory_are_disabled(self):
        home = self.base / "home"
        ssh = home / ".ssh"
        ssh.mkdir(parents=True)
        config = ssh / "config"
        config.write_text("Host github-haukeee\n  ControlPath none\n\nHost *\n  ControlMaster auto\n"
                          "  ControlPath ~/.ssh/control-%C\n  ControlPersist 10m\n  IdentityFile ~/.ssh/id_ed25519\n")
        state = self.base / "ssh-state"
        state.mkdir()
        args = []
        runtime.bind_ssh_configs(args, state, home)
        owned = Path(args[args.index(str(config.resolve())) - 1])
        self.assertEqual(owned.read_text(), config.read_text().replace("ControlPath ~/.ssh/control-%C", "ControlPath none"))

    def test_atomic_instruction_refresh_replaces_readonly_mount_placeholder(self):
        target = self.base / "AGENTS.md"
        target.touch(mode=0o444)
        runtime.write_text(target, "global and runtime instructions")
        self.assertEqual(target.read_text(), "global and runtime instructions")

    def test_tool_link_refresh_replaces_garbage_collected_target(self):
        link = self.base / "claude"
        link.symlink_to(self.base / "collected-store-path")
        current = self.base / "current-claude"
        current.touch()
        runtime.write_symlink(link, current)
        self.assertEqual(link.readlink(), current)


if __name__ == "__main__":
    unittest.main()
