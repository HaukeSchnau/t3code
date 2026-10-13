import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import agent_exec
import capabilities
import projects


class ProjectBindingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state = self.root / "state"
        self.record = {
            "root": str(self.root / "checkout"),
            "home": str(self.root / "home"),
            "workspace": {
                "id": "workspace:one",
                "visibleRoot": "/home/user/app",
                "sourceRoot": "/home/user/Code/app",
            },
        }
        self.runtime = Mock()
        self.runtime.lookup.return_value = self.record
        self.runtime.identity = agent_exec.identity
        self.runtime.write_text = agent_exec.write_text
        self.runtime.project_state.return_value = self.state

    def binding(self, identity="abc123", checkout=None, default=True):
        paths = {
            name: str(self.root / identity / name)
            for name in ["state", "cache", "runtime"]
        }
        spec = {
            "execution": projects.environment(self.runtime, self.record["root"]),
            "instanceId": identity,
            "checkout": checkout or self.record["root"],
            "default": default,
            "paths": paths,
            "executable": "/nix/store/example/bin/project-runtime",
            "endpoints": {},
            "secrets": {"account": str(self.root / "account-secret")},
        }
        file = self.root / (identity + ".json")
        file.write_text(json.dumps(spec))
        projects.bind(self.runtime, self.record, file)
        return spec

    def test_inspection_is_read_only_and_binding_preserves_workspace_identity(self):
        value = projects.environment(self.runtime, self.record["root"])
        self.assertEqual("workspace:one", value["workspaceId"])
        self.assertEqual("/home/user/Code/app", value["sourceRoot"])
        self.assertFalse(self.state.exists())
        spec = self.binding()
        context = projects.activation(self.runtime, self.record, self.record["root"])
        self.assertEqual(
            spec["paths"]["runtime"] + "/runtime.json", context["PROJECT_RUNTIME_FILE"]
        )
        self.assertNotIn("account-secret", json.dumps(context))
        self.runtime.lookup.return_value = None
        self.assertIsNone(projects.environment(self.runtime, self.record["root"]))

    def test_nested_project_and_default_instance_select_the_terminal_context(self):
        self.binding()
        nested_root = str(Path(self.record["root"]) / "nested")
        nested = self.binding("def456", nested_root)
        self.binding("fed987", nested_root, default=False)
        context = projects.activation(self.runtime, self.record, nested_root + "/src")
        self.assertEqual(
            nested["paths"]["runtime"] + "/runtime.json",
            context["PROJECT_RUNTIME_FILE"],
        )

    def test_project_bridge_preserves_stdio_execution_and_uses_host_checkout(self):
        root = Path(self.record["root"])
        root.mkdir()
        with patch("capabilities.shutil.which", return_value="/host/bin/project"):
            command, cwd, env = capabilities.command_context(
                agent_exec,
                self.record,
                {
                    "command": "project",
                    "args": ["dev", "console", "--help"],
                    "cwd": "/home/user/app",
                    "env": {"PROJECT_RUNTIME_FILE": "/other/runtime.json"},
                },
                self.state,
                self.root / "publishing",
            )
        self.assertEqual(["/host/bin/project", "dev", "console", "--help"], command)
        self.assertEqual(root, cwd)
        self.assertEqual(str(root), env["PROJECT_WORKSPACE_ROOT"])
        self.assertNotIn("PROJECT_RUNTIME_FILE", env)
