import array
import json
import os
import pty
import select
import signal
import socket
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_exec
import capabilities


class TransportTests(unittest.TestCase):
    def invoke(self, script, data=b"", signal_after_start=None, initial_signal=None):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with (
                tempfile.TemporaryFile() as stdin,
                tempfile.TemporaryFile() as stdout,
                tempfile.TemporaryFile() as stderr,
            ):
                stdin.write(data)
                stdin.seek(0)
                client, server = socket.socketpair()
                client.settimeout(5)
                self.addCleanup(client.close)
                self.addCleanup(server.close)
                with patch.object(
                    capabilities,
                    "command_context",
                    return_value=(
                        [sys.executable, "-c", script],
                        base,
                        dict(os.environ),
                    ),
                ):
                    worker = threading.Thread(
                        target=capabilities.serve_call, args=(server, agent_exec, {}, base, base)
                    )
                    worker.start()
                    client.sendmsg(
                        [
                            capabilities.encode({"tty": False})
                            + (
                                capabilities.encode({"signal": initial_signal})
                                if initial_signal
                                else b""
                            )
                        ],
                        [
                            (
                                socket.SOL_SOCKET,
                                socket.SCM_RIGHTS,
                                array.array(
                                    "i",
                                    [stdin.fileno(), stdout.fileno(), stderr.fileno()],
                                ),
                            )
                        ],
                    )
                    with client.makefile("rb") as replies:
                        self.assertEqual(
                            json.loads(replies.readline()), {"started": True}
                        )
                        if signal_after_start:
                            client.sendall(
                                capabilities.encode({"signal": signal_after_start})
                            )
                        result = json.loads(replies.readline())
                    worker.join(5)
                    self.assertFalse(worker.is_alive())
                stdout.seek(0)
                stderr.seek(0)
                return result, stdout.read(), stderr.read()

    def test_binary_stdio_and_native_exit(self):
        result, out, err = self.invoke(
            "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read()); sys.stderr.buffer.write(b'error\\x00'); sys.exit(23)",
            bytes(range(256)) * 1024,
        )
        self.assertEqual(result, {"code": 23})
        self.assertEqual(out, bytes(range(256)) * 1024)
        self.assertEqual(err, b"error\x00")

    def test_cancellation_terminates_native_process(self):
        result, _, _ = self.invoke(
            "import time; time.sleep(60)", signal_after_start=signal.SIGTERM
        )
        self.assertEqual(result, {"code": 143})

    def test_signal_coalesced_with_request_is_not_lost(self):
        result, _, _ = self.invoke(
            "import time; time.sleep(60)", initial_signal=signal.SIGTERM
        )
        self.assertEqual(result, {"code": 143})

    def test_interactive_terminal_streams_prompt_and_accepts_input(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            master, slave = pty.openpty()
            self.addCleanup(os.close, master)
            self.addCleanup(os.close, slave)
            client, server = socket.socketpair()
            self.addCleanup(client.close)
            self.addCleanup(server.close)
            client.settimeout(5)
            # The real CLI sets the caller terminal raw before relaying.
            import tty

            tty.setraw(slave)
            script = "import os; t=open('/dev/tty', 'w'); t.write('prompt>'); t.flush(); line=open('/dev/tty').readline(); print('received:'+line.strip())"
            with patch.object(
                capabilities,
                "command_context",
                return_value=([sys.executable, "-c", script], base, dict(os.environ)),
            ):
                worker = threading.Thread(
                    target=capabilities.serve_call, args=(server, agent_exec, {}, base, base)
                )
                worker.start()
                client.sendmsg(
                    [
                        capabilities.encode(
                            {
                                "tty": True,
                                "winsize": list(struct.pack("HHHH", 24, 80, 0, 0)),
                            }
                        )
                    ],
                    [
                        (
                            socket.SOL_SOCKET,
                            socket.SCM_RIGHTS,
                            array.array("i", [slave, slave, slave]),
                        )
                    ],
                )
                with client.makefile("rb") as replies:
                    self.assertEqual(json.loads(replies.readline()), {"started": True})
                    self.assertTrue(
                        select.select([master], [], [], 5)[0],
                        "prompt must arrive before exit",
                    )
                    output = os.read(master, 4096)
                    self.assertIn(b"prompt>", output)
                    os.write(master, b"hello\n")
                    self.assertEqual(json.loads(replies.readline()), {"code": 0})
                worker.join(5)
                self.assertFalse(worker.is_alive())
                while select.select([master], [], [], 0)[0]:
                    output += os.read(master, 4096)
                self.assertIn(b"received:hello", output)

    def test_disconnect_stops_process(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryFile() as io:
            base = Path(directory)
            client, server = socket.socketpair()
            self.addCleanup(server.close)
            client.settimeout(5)
            with patch.object(
                capabilities,
                "command_context",
                return_value=(
                    [sys.executable, "-c", "import time; time.sleep(60)"],
                    base,
                    dict(os.environ),
                ),
            ):
                worker = threading.Thread(
                    target=capabilities.serve_call, args=(server, agent_exec, {}, base, base)
                )
                worker.start()
                client.sendmsg(
                    [capabilities.encode({"tty": False})],
                    [
                        (
                            socket.SOL_SOCKET,
                            socket.SCM_RIGHTS,
                            array.array("i", [io.fileno()] * 3),
                        )
                    ],
                )
                self.assertIn(b"started", client.recv(4096))
                client.close()
                worker.join(5)
                self.assertFalse(worker.is_alive())


class ContextTests(unittest.TestCase):
    def test_device_uses_environment_shim_and_host_file_exchange(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, state, publishing = [
                base / name for name in ("project", "state", "published")
            ]
            root.mkdir()
            device = base / "t3" / "userdata" / "device"
            shim = device / "bin" / "agent-device"
            shim.parent.mkdir(parents=True)
            shim.write_text("#!/bin/sh\nexit 0\n")
            shim.chmod(0o755)
            config = device / "hosts" / "host.json"
            config.parent.mkdir()
            config.write_text("{}")
            args = [
                "screenshot",
                "/tmp/evidence.png",
                "--config",
                str(config),
                "--session",
                "t3-test",
            ]
            with patch.dict(os.environ, {"T3CODE_HOME": str(base / "t3")}):
                command, _, env = capabilities.command_context(
                    agent_exec,
                    {"root": str(root), "home": str(base / "home")},
                    {
                        "command": "agent-device",
                        "args": args,
                        "env": {
                            "T3CODE_HOME": "/wrong",
                            "AGENT_DEVICE_DAEMON_BASE_URL": "http://wrong",
                        },
                    },
                    state,
                    publishing,
                )
            self.assertEqual(command[-len(args) - 1 :], [str(shim), *args])
            self.assertNotIn("AGENT_DEVICE_DAEMON_BASE_URL", env)
            self.assertNotIn("--unshare-net", command)
            self.assertIn(str(state / "tmp"), command)
            self.assertIn(str(publishing), command)

    def test_device_help_needs_no_config(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            shim = base / "t3" / "userdata" / "device" / "bin" / "agent-device"
            shim.parent.mkdir(parents=True)
            shim.write_text("#!/bin/sh\nexit 0\n")
            shim.chmod(0o755)

            def context(args):
                return capabilities.command_context(
                    agent_exec,
                    {"root": str(base), "home": str(base / "home")},
                    {"command": "agent-device", "args": args},
                    base / "state",
                    base / "published",
                )

            with patch.dict(os.environ, {"T3CODE_HOME": str(base / "t3")}):
                for args in (["help", "cdp"], ["open", "--help"], ["snapshot", "-h"]):
                    self.assertEqual(context(args)[0][-len(args) :], args)
                with self.assertRaisesRegex(ValueError, "device_open"):
                    context(["open", "com.example"])

    def test_device_does_not_fall_back_to_global_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.dict(os.environ, {"T3CODE_HOME": str(root / "missing")}),
                self.assertRaisesRegex(ValueError, "device_open"),
            ):
                capabilities.command_context(
                    agent_exec,
                    {"root": str(root), "home": str(root)},
                    {"command": "agent-device", "args": ["--help"]},
                    root / "state",
                    root / "published",
                )

    def test_browser_sessions_are_scoped_and_accounts_are_explicit(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"XDG_RUNTIME_DIR": "/tmp"}),
        ):
            first = Path(directory) / "first-project"
            second = Path(directory) / "second-project"
            os.environ["XDG_RUNTIME_DIR"] = directory
            first_env, second_env = {}, {}
            one = capabilities.browser_command(
                "agent-browser", ["--session", "design", "snapshot"], first, first_env
            )
            two = capabilities.browser_command(
                "agent-browser", ["--session=design", "snapshot"], second, second_env
            )
            self.assertNotEqual(one[2], two[2])
            self.assertNotEqual(
                first_env["AGENT_BROWSER_PROFILE"], second_env["AGENT_BROWSER_PROFILE"]
            )
            self.assertEqual(
                capabilities.browser_command(
                    "agent-browser-personal", ["snapshot"], first, {}
                ),
                ["agent-browser", "snapshot"],
            )
            with self.assertRaises(ValueError):
                capabilities.browser_command(
                    "agent-browser", ["--profile", "/host/profile"], first, {}
                )

    def test_native_config_and_shared_working_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, state, publishing = [
                base / name for name in ("project", "state", "published")
            ]
            for path in (root, state / "tmp", state / "home", publishing):
                path.mkdir(parents=True)
            record = {"root": str(root), "home": str(base / "host-home")}
            # Home Manager links ~/.ssh/config to a root-owned store file, which
            # the user namespace shows as nobody's, and ssh refuses it.
            store_config = base / "store-ssh-config"
            store_config.write_text("Host m1\n")
            (base / "host-home/.ssh").mkdir(parents=True)
            (base / "host-home/.ssh/config").symlink_to(store_config)
            for visible, actual in [
                ("/tmp", state / "tmp"),
                ("/srv/agent-share", publishing),
                (str(root), root),
            ]:
                with patch.object(
                    capabilities.shutil, "which", return_value="/native/gog"
                ):
                    command, cwd, env = capabilities.command_context(
                        agent_exec,
                        record,
                        {
                            "command": "gog",
                            "args": ["auth", "status"],
                            "cwd": visible,
                            "env": {
                                "HOME": "/private/home",
                                "XDG_CONFIG_HOME": "/private/config",
                                "SHELL": "/private/bash",
                                "CUSTOM_OPTION": "yes",
                            },
                        },
                        state,
                        publishing,
                    )
                self.assertEqual(cwd, actual)
                self.assertEqual(env["HOME"], record["home"])
                self.assertNotEqual(env.get("XDG_CONFIG_HOME"), "/private/config")
                self.assertNotEqual(env.get("SHELL"), "/private/bash")
                self.assertEqual(env["CUSTOM_OPTION"], "yes")
                self.assertEqual(command[-3:], ["/native/gog", "auth", "status"])
                owned = Path(command[command.index(str(store_config)) - 1])
                self.assertTrue(owned.is_relative_to(state))
                self.assertEqual(owned.read_text(), "Host m1\n")


if __name__ == "__main__":
    unittest.main()
