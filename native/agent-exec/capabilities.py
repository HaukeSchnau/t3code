"""Native host CLI calls with descriptor forwarding and project-scoped file exchange."""

import array
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import termios
import threading
import tty
from pathlib import Path

COMMANDS = (
    "project",
    "chat-export",
    "gog",
    "himalaya",
    "personal-email-health",
    "bw-personal",
    "bw-work",
    "bitwarden-agent-health",
    "slackcli",
    "gh",
    "tea",
    "agent-browser",
    "agent-browser-personal",
    "agent-browser-buildlinx",
    "bitwarden-browser-ui-personal",
    "bitwarden-browser-ui-work",
    "play-console-browser",
    "asc",
    "gplay",
    "agent-device",
)
HOST_ENV = {
    "HOME",
    "PATH",
    "SHELL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SSH_AUTH_SOCK",
    "AGENT_EXEC_INSIDE",
    "AGENT_EXEC_LAUNCHER",
    "AGENT_EXEC_STATE",
    "T3CODE_HOME",
}


def encode(value):
    return json.dumps(value).encode() + b"\n"


def browser_command(command, argv, state, env):
    """Default browsing is project-local; account lanes remain explicit."""
    if command == "agent-browser-personal":
        return ["agent-browser", *argv]
    if command != "agent-browser":
        return [command, *argv]
    session = "default"
    remaining = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--session":
            index += 1
            if index == len(argv):
                raise ValueError("--session requires a name")
            session = argv[index]
        elif arg.startswith("--session="):
            session = arg.split("=", 1)[1]
        elif arg == "--profile" or arg.startswith("--profile="):
            raise ValueError(
                "Project browser profiles are managed; use --session for another project context"
            )
        else:
            remaining.append(arg)
        index += 1
    import hashlib

    identity = hashlib.sha256(session.encode()).hexdigest()[:12]
    profile = state / "browsers" / identity
    profile.mkdir(parents=True, exist_ok=True)
    env["AGENT_BROWSER_PROFILE"] = str(profile)
    socket_dir = (
        Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
        / "px-browser"
        / state.name
    )
    socket_dir.mkdir(parents=True, exist_ok=True)
    env["AGENT_BROWSER_SOCKET_DIR"] = str(socket_dir)
    return [
        "agent-browser",
        "--session",
        f"px-{state.name[:10]}-{identity}",
        *remaining,
    ]


def command_context(runtime, record, request, state, publishing):
    command = request["command"]
    argv = request["args"]
    if command not in COMMANDS:
        raise ValueError("Not a declared host capability")
    if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        raise ValueError("Arguments must be strings")
    visible_cwd = Path(request.get("cwd", record["root"]))
    root = Path(record["root"])
    cwd = visible_cwd
    visible_root = Path(record.get("workspace", {}).get("visibleRoot", root))
    if cwd.is_relative_to(visible_root):
        cwd = root / cwd.relative_to(visible_root)
    if not cwd.is_relative_to(root) and not cwd.is_relative_to(state):
        for visible, actual in [
            (Path("/tmp"), state / "tmp"),
            (Path("/srv/agent-share"), publishing),
            (Path(record["home"]), state / "home"),
        ]:
            if cwd.is_relative_to(visible):
                cwd = actual / cwd.relative_to(visible)
                break
    cwd = cwd.resolve()
    if not (
        cwd.is_relative_to(root)
        or cwd.is_relative_to(state)
        or cwd.is_relative_to(publishing)
    ):
        raise ValueError(
            "Host capability working directory must be in the project or its scratch space"
        )
    env = dict(os.environ)
    supplied = request.get("env", {})
    if not isinstance(supplied, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in supplied.items()
    ):
        raise ValueError("Environment must contain string values")
    env.update({k: v for k, v in supplied.items() if k not in HOST_ENV})
    env.pop("AGENT_EXEC_INSIDE", None)
    env["HOME"] = record["home"]
    env["TMPDIR"] = str(state / "tmp")
    env["AGENT_EXEC_ROOT"] = record["root"]
    # Browser daemons outlive a CLI call. Give them real shared paths, never a
    # transient mount namespace's /tmp or publication alias.
    browser = command.startswith("agent-browser")
    if browser:
        # Chromium puts Unix sockets below TMPDIR; the private state path is
        # too long for sockaddr_un. Browser artifacts use the shared dirs below.
        env["TMPDIR"] = "/tmp"
        outputs = state / "tmp" / "browser"
        outputs.mkdir(parents=True, exist_ok=True)
        env["AGENT_BROWSER_SCREENSHOT_DIR"] = str(outputs)
        env["AGENT_BROWSER_DOWNLOAD_PATH"] = str(outputs)

        def translate(arg):
            for visible, actual in [
                (str(visible_root) + "/", str(root) + "/"),
                ("/tmp/", str(state / "tmp") + "/"),
                ("/srv/agent-share/", str(state / "published") + "/"),
            ]:
                if arg.startswith(visible):
                    return actual + arg[len(visible) :]
                if "=" in arg and arg.split("=", 1)[1].startswith(visible):
                    key, value = arg.split("=", 1)
                    return key + "=" + actual + value[len(visible) :]
            return arg

        argv = [translate(arg) for arg in argv]
    native = browser_command(command, argv, state, env)
    if command == "agent-device":
        # The bridge belongs to its launching T3 environment. Never fall back
        # to a globally installed CLI with unrelated daemon/session state.
        t3_home = Path(os.environ.get("T3CODE_HOME", str(Path(record["home"]) / ".t3")))
        device_dir = t3_home / "userdata" / "device"
        binary = str(device_dir / "bin" / "agent-device")
        if not os.access(binary, os.X_OK):
            raise ValueError("Enable T3 agent device access and call device_open first")
        # Mirror T3's generated launcher: help output needs no device flags.
        informational = (
            argv[:1] == ["help"]
            or "--help" in argv
            or "-h" in argv
            or argv in (["--version"], ["version"])
        )
        if not informational:
            configs = [i for i, arg in enumerate(argv) if arg == "--config"]
            if len(configs) != 1 or configs[0] + 1 >= len(argv):
                raise ValueError(
                    "Use the --config and --session returned by device_open"
                )
            config = Path(argv[configs[0] + 1]).resolve()
            if (
                config.parent != (device_dir / "hosts").resolve()
                or not config.is_file()
            ):
                raise ValueError("Device config must belong to this T3 environment")
        for key in list(env):
            if key.startswith("AGENT_DEVICE_"):
                env.pop(key)
    else:
        binary = shutil.which(native[0], path=env["PATH"])
    if binary is None:
        raise ValueError(f"Host capability {native[0]} is not installed")
    native[0] = binary
    if command == "project":
        # Project performs the namespace entry for its application commands.
        # Its controller must see the real checkout and host service manager.
        if not cwd.is_relative_to(root):
            raise ValueError("Run Project from a project root inside this workspace")
        if not argv or argv[0] not in {
            "inspect",
            "plan",
            "export",
            "dev",
            "obs",
            "--help",
            "-h",
        }:
            raise ValueError(
                "Workspace Project commands cover inspection and Development"
            )
        if argv[0] == "dev" and len(argv) > 1 and argv[1] in {"reconcile", "relocate"}:
            raise ValueError(
                "Workspace registration and relocation are host operations"
            )
        env["PROJECT_WORKSPACE_ROOT"] = str(root)
        for key in list(env):
            if key.startswith("PROJECT_") and key != "PROJECT_WORKSPACE_ROOT":
                env.pop(key)
        return native, cwd, env
    if browser:
        if command == "agent-browser" and record.get("workspace"):
            pid = int((state / "network-pid").read_text())
            native = [
                "nsenter",
                f"--user=/proc/{pid}/ns/user",
                f"--net=/proc/{pid}/ns/net",
                "--preserve-credentials",
                *native,
            ]
        return native, cwd, env
    # Account configuration stays in its native host home. Only project file
    # exchange aliases differ. The command cannot be a project shell fallback.
    mounts = [
        (root, str(visible_root)),
        (state / "tmp", "/tmp"),
        (publishing, "/srv/agent-share"),
        (
            state / "attachments",
            str(Path(record["home"]) / ".local/state/agent-bitwarden/attachments"),
        ),
    ]
    # A fresh /dev is required for Bun executables on this host; inheriting
    # /dev through the root bind causes Bun startup to abort before the CLI runs.
    wrapped = ["bwrap", "--die-with-parent", "--bind", "/", "/", "--dev", "/dev"]
    for source, target in mounts:
        source.mkdir(parents=True, exist_ok=True)
        wrapped += ["--bind", str(source), target]
    runtime.bind_ssh_configs(wrapped, state, Path(record["home"]))
    execution_cwd = (
        Path("/srv/agent-share") / cwd.relative_to(publishing)
        if cwd.is_relative_to(publishing)
        else cwd
    )
    return [*wrapped, "--chdir", str(execution_cwd), "--", *native], cwd, env


def terminate(process, signum=signal.SIGTERM):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass


def serve_call(connection, runtime, record, state, publishing):
    fds = []
    process = None
    master = None
    try:
        packet, ancillary, flags, _ = connection.recvmsg(
            1024 * 1024, socket.CMSG_SPACE(3 * array.array("i").itemsize)
        )
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array("i")
                values.frombytes(
                    payload[: len(payload) - len(payload) % values.itemsize]
                )
                fds.extend(values)
        if flags & socket.MSG_CTRUNC or len(fds) != 3:
            raise ValueError("Bridge requires stdin, stdout and stderr descriptors")
        while b"\n" not in packet and len(packet) <= 1024 * 1024:
            chunk = connection.recv(65536)
            if not chunk:
                raise ValueError("Incomplete capability request")
            packet += chunk
        header, separator, pending = packet.partition(b"\n")
        if not separator:
            raise ValueError("Capability request exceeds the size limit")
        request = json.loads(header)
        command, cwd, env = command_context(runtime, record, request, state, publishing)
        interactive = bool(request.get("tty"))
        if interactive:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, bytes(request["winsize"]))
            try:
                process = subprocess.Popen(
                    [sys.executable, __file__, "tty-exec", *command],
                    stdin=slave,
                    stdout=slave,
                    stderr=slave,
                    cwd=cwd,
                    env=env,
                    start_new_session=True,
                )
            finally:
                os.close(slave)
        else:
            process = subprocess.Popen(
                command,
                stdin=fds[0],
                stdout=fds[1],
                stderr=fds[2],
                cwd=cwd,
                env=env,
                start_new_session=True,
            )
        connection.sendall(encode({"started": True}))
        inputs = [connection]
        if interactive:
            inputs += [master, fds[0]]
        while process.poll() is None or master in inputs:
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                event = json.loads(line)
                if "signal" in event:
                    terminate(process, int(event["signal"]))
                if master is not None and "winsize" in event:
                    fcntl.ioctl(master, termios.TIOCSWINSZ, bytes(event["winsize"]))
            ready, _, _ = select.select(inputs, [], [], 0.1)
            for descriptor in ready:
                if descriptor is connection:
                    chunk = connection.recv(4096)
                    if not chunk:
                        terminate(process)
                        inputs.remove(connection)
                        try:
                            process.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            terminate(process, signal.SIGKILL)
                        break
                    pending += chunk
                else:
                    try:
                        chunk = os.read(descriptor, 65536)
                    except OSError:
                        chunk = b""
                    if not chunk:
                        inputs.remove(descriptor)
                    else:
                        destination = fds[1] if descriptor == master else master
                        view = memoryview(chunk)
                        while view:
                            view = view[os.write(destination, view) :]
            if connection not in inputs:
                break
        code = process.wait()
        connection.sendall(encode({"code": code if code >= 0 else 128 - code}))
    except (OSError, ValueError, KeyError, TypeError) as error:
        try:
            connection.sendall(encode({"code": 1, "error": str(error)}))
        except OSError:
            pass
    finally:
        if process is not None:
            terminate(process)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                terminate(process, signal.SIGKILL)
                process.wait()
        for descriptor in fds + ([master] if master is not None else []):
            os.close(descriptor)


def start_server(runtime, path, record, state, publishing):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            serve_call(self.request, runtime, record, state, publishing)

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True

    path.unlink(missing_ok=True)
    server = Server(str(path), Handler)
    path.chmod(0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def call(command, argv):
    interactive = all(os.isatty(fd) for fd in (0, 1, 2))
    saved = termios.tcgetattr(0) if interactive else None
    handlers = {}
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect("/run/agent-exec/capabilities")
        request = {
            "command": command,
            "args": argv,
            "cwd": os.getcwd(),
            "env": dict(os.environ),
            "tty": interactive,
        }
        if interactive:
            request["winsize"] = list(fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
        connection.sendmsg(
            [encode(request)],
            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [0, 1, 2]))],
        )

        def forward(signum, _):
            try:
                if signum == signal.SIGWINCH and interactive:
                    connection.sendall(
                        encode(
                            {
                                "winsize": list(
                                    fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
                                )
                            }
                        )
                    )
                else:
                    connection.sendall(encode({"signal": signum}))
            except OSError:
                pass

        try:
            for signum in [
                signal.SIGINT,
                signal.SIGTERM,
                signal.SIGHUP,
                signal.SIGWINCH,
            ]:
                handlers[signum] = signal.signal(signum, forward)
            if interactive:
                tty.setraw(0)
            for line in connection.makefile("rb"):
                response = json.loads(line)
                if "error" in response:
                    print("agent-exec: " + response["error"], file=sys.stderr)
                if "code" in response:
                    return response["code"]
            print("agent-exec: host capability connection closed", file=sys.stderr)
            return 1
        finally:
            if saved is not None:
                termios.tcsetattr(0, termios.TCSADRAIN, saved)
            for signum, handler in handlers.items():
                signal.signal(signum, handler)


if __name__ == "__main__" and sys.argv[1:2] == ["tty-exec"]:
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
