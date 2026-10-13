"""Project bindings and prepared services inside an existing workspace runtime."""

import json
import os
from pathlib import Path
import re


def environment(runtime, cwd):
    record = runtime.lookup(cwd)
    if not record or not record.get("workspace"):
        return None
    return {
        "id": runtime.identity(record["root"]),
        "root": record["root"],
        "workspaceId": record["workspace"].get("id"),
        "visibleRoot": record["workspace"]["visibleRoot"],
        "sourceRoot": record["workspace"]["sourceRoot"],
    }


def bind(runtime, record, file):
    spec = json.loads(Path(file).read_text())
    if not re.fullmatch(r"[a-z0-9-]+", spec["instanceId"]):
        raise ValueError("Invalid Project instance identity")
    if spec["execution"] != environment(runtime, record["root"]):
        raise ValueError(
            "Project execution environment no longer matches its workspace"
        )
    if not Path(spec["checkout"]).resolve().is_relative_to(record["root"]):
        raise ValueError("Project checkout must belong to this workspace")
    directory = runtime.project_state(record) / "project-bindings"
    directory.mkdir(parents=True, exist_ok=True)
    runtime.write_text(directory / (spec["instanceId"] + ".json"), json.dumps(spec))


def unbind(runtime, record, instance):
    if not re.fullmatch(r"[a-z0-9-]+", instance):
        raise ValueError("Invalid Project instance identity")
    (runtime.project_state(record) / "project-bindings" / (instance + ".json")).unlink(
        missing_ok=True
    )


def bindings(runtime, record):
    directory = runtime.project_state(record) / "project-bindings"
    return [json.loads(file.read_text()) for file in sorted(directory.glob("*.json"))]


def mounts(runtime, record, args):
    for spec in bindings(runtime, record):
        for path in spec["paths"].values():
            runtime.bind(args, path, writable=True)
        for name, source in spec["secrets"].items():
            runtime.bind(
                args,
                source,
                Path(spec["paths"]["runtime"]) / "workspace-secrets" / name,
            )


def activation(runtime, record, cwd):
    candidates = [
        spec
        for spec in bindings(runtime, record)
        if Path(cwd).resolve().is_relative_to(spec["checkout"])
    ]
    if not candidates:
        return {}
    # Nested project roots take precedence. A named instance is selected through
    # `project dev --name`; an ordinary terminal uses the checkout's default.
    candidates.sort(
        key=lambda spec: (len(Path(spec["checkout"]).parts), spec["default"]),
        reverse=True,
    )
    spec = candidates[0]
    return {
        "PROJECT_RUNTIME_FILE": spec["paths"]["runtime"] + "/runtime.json",
        "PROJECT_SECRETS_DIR": spec["paths"]["runtime"] + "/workspace-secrets",
        "PROJECT_DEVENV_MANAGED": "1",
        "PROJECT_CONTEXT_BIN": str(Path(spec["executable"]).parent),
    }


def run(runtime, record, file, command):
    """The manager owns its forwarding entries; command calls reuse them."""
    spec = json.loads(Path(file).read_text())
    if spec["execution"] != environment(runtime, record["root"]):
        raise ValueError(
            "Project execution environment no longer matches its workspace"
        )
    entries = []
    manager = os.environ.get("PROJECT_EXECUTION_ACTION") == "manager"
    if manager:
        runtime.workspaces.ensure_network(runtime, record)
        existing = runtime.workspaces.forwarding(runtime, record, "list_hostfwd")[
            "entries"
        ]
        for endpoint in spec["endpoints"].values():
            # A killed launcher can leave its slirp entry behind. Only replace
            # this instance's allocated host port, never another service's entry.
            for entry in existing:
                if entry["host_port"] == endpoint["host"]:
                    runtime.workspaces.forwarding(
                        runtime, record, "remove_hostfwd", {"id": entry["id"]}
                    )
            entries.append(
                runtime.workspaces.forwarding(
                    runtime,
                    record,
                    "add_hostfwd",
                    {
                        "proto": "tcp",
                        "host_addr": "127.0.0.1",
                        "host_port": endpoint["host"],
                        "guest_addr": "10.0.2.100",
                        "guest_port": endpoint["guest"],
                    },
                )["id"]
            )
    try:
        return runtime.launch(record, spec["checkout"], command, project=spec)
    finally:
        for entry in entries:
            try:
                runtime.workspaces.forwarding(
                    runtime, record, "remove_hostfwd", {"id": entry}
                )
            except (OSError, ValueError):
                pass


def retire(runtime, record):
    specs = bindings(runtime, record)
    if specs:
        runtime.run(
            ["project", "internal", "retire-workspace", "--root", record["root"]]
        )
        for spec in specs:
            (
                runtime.project_state(record)
                / "project-bindings"
                / (spec["instanceId"] + ".json")
            ).unlink(missing_ok=True)
